'use strict';

const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, test, before, after, beforeEach, afterEach } = require('node:test');
const evernode = require('evernode-js-client');
const kp = require('ripple-keypairs');
const EvernodeContext = require('../../dist/context/EvernodeContext').default;

// Public stand-in for a consensus lclHash. These 32 bytes are also a valid
// secp256k1 scalar, so a mutant that feeds them to ECIES still returns and the
// assertions are what fail.
const FIXED_LCL_HASH = '1a20bec21ef8038f32eaed2f4d1907b9f0bdcc02e05d1ee09b199ac13db6518a';
const IV_LENGTH = 16;
const EPHEMERAL_KEY_LENGTH = 32;
const EPHEMERAL_PUBLIC_KEY_LENGTH = 65;
const ENCRYPTED_MEMO_FLAG = 0x01;
const HASH_ALGORITHMS = ['sha1', 'sha256', 'sha384', 'sha512'];
const TENANT_ADDRESS = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
const HOST_ADDRESS = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe';
const LEASE_OFFER_INDEX = 'A1B2C3D4E5F60718293A4B5C6D7E8F90112233445566778899AABBCCDDEEFF00';

const INSTANCE_CFG = {
    ownerPubkey: 'ed3b4f907632e222987809a35e8ea55ed3b5d2e406b7d230a5e6f39a5e9834bafb',
    contractId: 'dc411912-bcdd-4f73-af43-32ec45844b9a',
    image: 'evernodedev/sashimono:hp.udpvisa-test-0.0.1-ubt.20.04-njs.20',
    config: {}
};

const LEASE_OFFER = {
    Flags: 1,
    Issuer: HOST_ADDRESS,
    Owner: HOST_ADDRESS,
    Amount: {
        currency: 'EVR',
        issuer: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
        value: '1'
    },
    index: LEASE_OFFER_INDEX,
    URI: '6576726C65617365'
};

const capturedKeyMaterial = [];
const submittedTransactions = [];
const stubApi = {};

let originalCwd;
let hostPrivateKey;
let hostAccount;
let originals;

describe('acquire key material comes from a CSPRNG', { concurrency: 1 }, () => {
    before(() => {
        originalCwd = process.cwd();
        const seed = kp.generateSeed({ algorithm: 'ecdsa-secp256k1' });
        const hostKeyPair = kp.deriveKeypair(seed);
        hostPrivateKey = hostKeyPair.privateKey;
        hostAccount = new evernode.XrplAccount(HOST_ADDRESS, null, { xrplApi: stubApi });
        hostAccount.getMessageKey = async () => hostKeyPair.publicKey;

        originals = {
            connect: evernode.TenantClient.prototype.connect,
            disconnect: evernode.TenantClient.prototype.disconnect,
            getLeaseHost: evernode.TenantClient.prototype.getLeaseHost,
            prepareAcquireLeaseTransaction: evernode.TenantClient.prototype.prepareAcquireLeaseTransaction,
            prepareBuyURIToken: evernode.XrplAccount.prototype.prepareBuyURIToken,
            getLeaseOffers: evernode.EvernodeHelpers.getLeaseOffers,
            defaults: evernode.Defaults.values
        };

        // Network boundary only. Encryption, memo formatting, and acquireSubmit stay real.
        evernode.TenantClient.prototype.connect = async () => true;
        evernode.TenantClient.prototype.disconnect = async () => { };
        evernode.TenantClient.prototype.getLeaseHost = async () => hostAccount;
        evernode.EvernodeHelpers.getLeaseOffers = async () => [LEASE_OFFER];
        evernode.XrplAccount.prototype.prepareBuyURIToken = async function (uriToken, memos = null, options = {}) {
            const tx = {
                Account: this.address,
                TransactionType: 'URITokenBuy',
                Amount: uriToken.Amount,
                URITokenID: uriToken.index
            };
            if (memos)
                tx.Memos = evernode.TransactionHelper.formatMemos(memos);
            if (options.hookParams)
                tx.HookParameters = evernode.TransactionHelper.formatHookParams(options.hookParams);
            return tx;
        };
        evernode.TenantClient.prototype.prepareAcquireLeaseTransaction = async function (hostAddress, requirement, options = {}) {
            const iv = Buffer.from(options.iv);
            const ephemPrivateKey = Buffer.from(options.ephemPrivateKey);
            capturedKeyMaterial.push({ iv, ephemPrivateKey });
            // evernode's ECIES helper rejects a short IV on a detached promise, which
            // the test runner reports as a crash. Record the bytes, then enter the
            // real encrypt path only when the lengths match the protocol.
            if (iv.length !== IV_LENGTH || ephemPrivateKey.length !== EPHEMERAL_KEY_LENGTH)
                throw new Error(`acquire key material length iv=${iv.length} ephem=${ephemPrivateKey.length}`);
            return originals.prepareAcquireLeaseTransaction.call(this, hostAddress, requirement, options);
        };
    });

    after(() => {
        evernode.TenantClient.prototype.connect = originals.connect;
        evernode.TenantClient.prototype.disconnect = originals.disconnect;
        evernode.TenantClient.prototype.getLeaseHost = originals.getLeaseHost;
        evernode.TenantClient.prototype.prepareAcquireLeaseTransaction = originals.prepareAcquireLeaseTransaction;
        evernode.XrplAccount.prototype.prepareBuyURIToken = originals.prepareBuyURIToken;
        evernode.EvernodeHelpers.getLeaseOffers = originals.getLeaseOffers;
        evernode.Defaults.set({ xrplApi: originals.defaults.xrplApi });
        process.chdir(originalCwd);
    });

    let workDir;

    beforeEach(() => {
        capturedKeyMaterial.length = 0;
        submittedTransactions.length = 0;
        workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acquire-csprng-'));
        process.chdir(workDir);
    });

    afterEach(() => {
        process.chdir(originalCwd);
        fs.rmSync(workDir, { recursive: true, force: true });
    });

    test('acquire IV and ephemeral key differ across calls with the same lclHash', async () => {
        const ctx = newContext(FIXED_LCL_HASH);
        const first = await driveAcquire(ctx);
        const second = await driveAcquire(ctx);

        assert.equal(capturedKeyMaterial.length, 2, 'acquire encryption must run for both calls');
        assertKeyLength(capturedKeyMaterial[0]);
        assertKeyLength(capturedKeyMaterial[1]);
        assert.ok(
            !capturedKeyMaterial[0].iv.equals(capturedKeyMaterial[1].iv),
            `acquire IVs must differ for the same lclHash: ${capturedKeyMaterial[0].iv.toString('hex')} vs ${capturedKeyMaterial[1].iv.toString('hex')}`
        );
        assert.ok(
            !capturedKeyMaterial[0].ephemPrivateKey.equals(capturedKeyMaterial[1].ephemPrivateKey),
            `acquire ephemeral keys must differ for the same lclHash: ${capturedKeyMaterial[0].ephemPrivateKey.toString('hex')} vs ${capturedKeyMaterial[1].ephemPrivateKey.toString('hex')}`
        );
        assert.ok(first.error == null, `acquireSubmit failed: ${first.error}`);
        assert.ok(second.error == null, `acquireSubmit failed: ${second.error}`);
    });

    test('acquire key material is not a slice or hash of lclHash', async () => {
        const ctx = newContext(FIXED_LCL_HASH);
        const driven = await driveAcquire(ctx);

        assert.equal(capturedKeyMaterial.length, 1, 'acquire encryption must run');
        assertKeyLength(capturedKeyMaterial[0]);
        assertNotSliceOrHash(capturedKeyMaterial[0].iv, FIXED_LCL_HASH, 'acquire IV');
        assertNotSliceOrHash(capturedKeyMaterial[0].ephemPrivateKey, FIXED_LCL_HASH, 'acquire ephemeral key');
        assert.ok(driven.error == null, `acquireSubmit failed: ${driven.error}`);
    });

    test('acquire ciphertext round-trips through the real decrypt', async () => {
        const ctx = newContext(FIXED_LCL_HASH);
        const messageKey = tenantMessageKey();
        const driven = await driveAcquire(ctx, messageKey);

        assert.equal(capturedKeyMaterial.length, 1, 'acquire encryption must run');
        assertKeyLength(capturedKeyMaterial[0]);
        assert.ok(driven.error == null, `acquireSubmit failed: ${driven.error}`);
        assert.equal(submittedTransactions.length, 1, 'prepared acquire transaction must be submitted');

        const memos = evernode.TransactionHelper.deserializeMemos(submittedTransactions[0].Memos);
        assert.equal(memos.length, 1, 'acquire transaction must carry one memo');
        assert.equal(memos[0].type, evernode.EventTypes.ACQUIRE_LEASE, 'acquire memo type');
        const wrapped = Buffer.from(memos[0].data, 'base64');
        assert.equal(wrapped[0], ENCRYPTED_MEMO_FLAG, 'acquire memo payload is encrypted');
        const encrypted = wrapped.subarray(1).toString('base64');
        const plain = await evernode.EncryptionHelper.decrypt(hostPrivateKey, encrypted);

        assert.equal(plain.owner_pubkey, INSTANCE_CFG.ownerPubkey, 'decrypted owner_pubkey');
        assert.equal(plain.contract_id, INSTANCE_CFG.contractId, 'decrypted contract_id');
        assert.equal(plain.image, INSTANCE_CFG.image, 'decrypted image');
        assert.deepEqual(plain.config, INSTANCE_CFG.config, 'decrypted config');
        assert.equal(plain.messageKey, messageKey, 'decrypted messageKey');
        const ciphertextIv = wrapped.subarray(
            1 + EPHEMERAL_PUBLIC_KEY_LENGTH,
            1 + EPHEMERAL_PUBLIC_KEY_LENGTH + IV_LENGTH
        );
        assert.equal(ciphertextIv.length, IV_LENGTH, 'ciphertext IV length');
        assert.ok(
            ciphertextIv.equals(capturedKeyMaterial[0].iv),
            'ciphertext IV must be the IV acquireSubmit generated'
        );
    });
});

function newContext(lclHash) {
    // R1 exception: the locked context had no node-set source. Production reads
    // HotPocketContext.getContractUnl(), and a missing-UNL fallback is forbidden.
    const HotPocketContext = require('../../dist/context/HotPocketContext').default;
    const publicKey = 'ed' + '11'.repeat(32);
    let hp;
    const contractContext = {
        publicKey: publicKey,
        contractId: 'dc411912-bcdd-4f73-af43-32ec45844b9a',
        lclSeqNo: 42,
        lclHash: lclHash,
        timestamp: 1,
        unl: {
            list: () => [{ publicKey: publicKey, activeOn: 1 }],
            send: (message) => {
                hp.voteContext.feedUnlMessage({ publicKey: publicKey, activeOn: 1 }, Buffer.from(message));
                return Promise.resolve();
            }
        }
    };
    hp = new HotPocketContext(contractContext);
    return new EvernodeContext({
        hpContext: hp,
        voteContext: hp.voteContext,
        xrplApi: stubApi,
        xrplAcc: { address: TENANT_ADDRESS },
        async multiSignAndSubmitTransaction(transaction) {
            submittedTransactions.push(transaction);
            return {
                hash: crypto.createHash('sha512').update(JSON.stringify(transaction)).digest('hex'),
                lastLedgerSequence: 52,
                resultCode: 'tesSUCCESS'
            };
        }
    });
}

async function driveAcquire(ctx, messageKey = tenantMessageKey()) {
    try {
        const result = await ctx.acquireSubmit(HOST_ADDRESS, LEASE_OFFER, messageKey, { instanceCfg: INSTANCE_CFG });
        return { error: null, result };
    } catch (error) {
        return { error, result: null };
    }
}

function tenantMessageKey() {
    const seed = kp.generateSeed({ algorithm: 'ecdsa-secp256k1' });
    return kp.deriveKeypair(seed).publicKey;
}

function assertKeyLength(material) {
    assert.equal(material.iv.length, IV_LENGTH, `acquire IV length, got ${material.iv.length}`);
    assert.equal(
        material.ephemPrivateKey.length,
        EPHEMERAL_KEY_LENGTH,
        `acquire ephemeral key length, got ${material.ephemPrivateKey.length}`
    );
}

function assertNotSliceOrHash(material, lclHash, label) {
    const bases = [Buffer.from(lclHash, 'hex'), Buffer.from(lclHash, 'utf8')];
    for (const algorithm of HASH_ALGORITHMS) {
        bases.push(crypto.createHash(algorithm).update(Buffer.from(lclHash, 'hex')).digest());
        bases.push(crypto.createHash(algorithm).update(lclHash, 'utf8').digest());
    }
    for (const base of bases) {
        const slice = base.subarray(0, material.length);
        const equalSlice = slice.length === material.length && material.equals(slice);
        assert.ok(!equalSlice, `${label} must not equal a slice or hash of lclHash`);
    }
}
