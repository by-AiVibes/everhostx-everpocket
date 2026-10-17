'use strict';
// acquireSubmit must draw a fresh IV and ephemeral key. The same hpContext
// (same lclHash) called twice has to produce different bytes, and neither
// byte string may be a slice or hash of lclHash.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const evernode = require('evernode-js-client');
const kp = require('ripple-keypairs');
const { DIST } = require('./lib/env');
const { acquireMaterialSite } = require('./lib/sites');

const FIXED_LCL_HASH = '1a20bec21ef8038f32eaed2f4d1907b9f0bdcc02e05d1ee09b199ac13db6518a';
const IV_LENGTH = 16;
const EPHEMERAL_KEY_LENGTH = 32;
const HASH_ALGORITHMS = ['sha1', 'sha256', 'sha384', 'sha512'];
const TENANT_ADDRESS = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
const HOST_ADDRESS = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe';
const LEASE_OFFER_INDEX = 'A1B2C3D4E5F60718293A4B5C6D7E8F90112233445566778899AABBCCDDEEFF00';
const INSTANCE_CFG = {
    ownerPubkey: 'ed3b4f907632e222987809a35e8ea55ed3b5d2e406b7d230a5e6f39a5e9834bafb',
    contractId: 'dc411912-bcdd-4f73-af43-32ec45844b9a',
    image: 'evernodedev/sashimono:hp.udpvisa-test-0.0.1-ubt.20.04-njs.20',
    config: {},
};
const LEASE_OFFER = {
    Flags: 1,
    Issuer: HOST_ADDRESS,
    Owner: HOST_ADDRESS,
    Amount: { currency: 'EVR', issuer: TENANT_ADDRESS, value: '1' },
    index: LEASE_OFFER_INDEX,
    URI: '6576726C65617365',
};

function notSliceOrHash(material, lclHash, label, site) {
    const bases = [Buffer.from(lclHash, 'hex'), Buffer.from(lclHash, 'utf8')];
    for (const algorithm of HASH_ALGORITHMS) {
        bases.push(crypto.createHash(algorithm).update(Buffer.from(lclHash, 'hex')).digest());
        bases.push(crypto.createHash(algorithm).update(lclHash, 'utf8').digest());
    }
    for (const base of bases) {
        const slice = base.subarray(0, material.length);
        const equalSlice = slice.length === material.length && material.equals(slice);
        assert.equal(equalSlice, false, `${site}: ${label} must not equal a slice or hash of lclHash`);
    }
}

test('acquire IV and ephemeral key come from a CSPRNG', { timeout: 60000 }, async () => {
    const site = acquireMaterialSite();
    const EvernodeContext = require(path.join(DIST, 'context', 'EvernodeContext.js')).default;
    const captured = [];
    const originals = {
        connect: evernode.TenantClient.prototype.connect,
        disconnect: evernode.TenantClient.prototype.disconnect,
        getLeaseHost: evernode.TenantClient.prototype.getLeaseHost,
        prepare: evernode.TenantClient.prototype.prepareAcquireLeaseTransaction,
        prepareBuy: evernode.XrplAccount.prototype.prepareBuyURIToken,
        getLeaseOffers: evernode.EvernodeHelpers.getLeaseOffers,
        defaults: evernode.Defaults.values,
    };
    const seed = kp.generateSeed({ algorithm: 'ecdsa-secp256k1' });
    const hostKeyPair = kp.deriveKeypair(seed);
    const stubApi = {};
    const hostAccount = new evernode.XrplAccount(HOST_ADDRESS, null, { xrplApi: stubApi });
    hostAccount.getMessageKey = async () => hostKeyPair.publicKey;
    const previousCwd = process.cwd();
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-acquire-'));
    evernode.TenantClient.prototype.connect = async () => true;
    evernode.TenantClient.prototype.disconnect = async () => {};
    evernode.TenantClient.prototype.getLeaseHost = async () => hostAccount;
    evernode.EvernodeHelpers.getLeaseOffers = async () => [LEASE_OFFER];
    evernode.XrplAccount.prototype.prepareBuyURIToken = async function prepareBuy(uriToken, memos = null, options = {}) {
        const tx = {
            Account: this.address,
            TransactionType: 'URITokenBuy',
            Amount: uriToken.Amount,
            URITokenID: uriToken.index,
        };
        if (memos)
            tx.Memos = evernode.TransactionHelper.formatMemos(memos);
        if (options.hookParams)
            tx.HookParameters = evernode.TransactionHelper.formatHookParams(options.hookParams);
        return tx;
    };
    evernode.TenantClient.prototype.prepareAcquireLeaseTransaction = async function prepareAcquire(hostAddress, requirement, options = {}) {
        const iv = Buffer.from(options.iv);
        const ephemPrivateKey = Buffer.from(options.ephemPrivateKey);
        captured.push({ iv, ephemPrivateKey });
        if (iv.length !== IV_LENGTH || ephemPrivateKey.length !== EPHEMERAL_KEY_LENGTH)
            throw new Error(`acquire key material length iv=${iv.length} ephem=${ephemPrivateKey.length}`);
        return originals.prepare.call(this, hostAddress, requirement, options);
    };
    try {
        process.chdir(workDir);
        const messageSeed = kp.generateSeed({ algorithm: 'ecdsa-secp256k1' });
        const messageKey = kp.deriveKeypair(messageSeed).publicKey;
        const ctx = new EvernodeContext({
            hpContext: { lclHash: FIXED_LCL_HASH, lclSeqNo: 42 },
            voteContext: {},
            xrplApi: stubApi,
            xrplAcc: { address: TENANT_ADDRESS },
            async multiSignAndSubmitTransaction(transaction) {
                return {
                    hash: crypto.createHash('sha512').update(JSON.stringify(transaction)).digest('hex'),
                    lastLedgerSequence: 52,
                    resultCode: 'tesSUCCESS',
                };
            },
        });
        const first = await ctx.acquireSubmit(HOST_ADDRESS, LEASE_OFFER, messageKey, { instanceCfg: INSTANCE_CFG });
        const second = await ctx.acquireSubmit(HOST_ADDRESS, LEASE_OFFER, messageKey, { instanceCfg: INSTANCE_CFG });
        assert.equal(captured.length, 2, `${site}: acquire encryption must run for both calls`);
        assert.equal(captured[0].iv.length, IV_LENGTH, `${site}: acquire IV length, got ${captured[0].iv.length}`);
        assert.equal(captured[1].iv.length, IV_LENGTH, `${site}: acquire IV length, got ${captured[1].iv.length}`);
        assert.equal(captured[0].ephemPrivateKey.length, EPHEMERAL_KEY_LENGTH, `${site}: acquire ephemeral key length, got ${captured[0].ephemPrivateKey.length}`);
        assert.equal(captured[1].ephemPrivateKey.length, EPHEMERAL_KEY_LENGTH, `${site}: acquire ephemeral key length, got ${captured[1].ephemPrivateKey.length}`);
        assert.equal(
            captured[0].iv.equals(captured[1].iv),
            false,
            `${site}: acquire IVs must differ for the same lclHash: ${captured[0].iv.toString('hex')} vs ${captured[1].iv.toString('hex')}`
        );
        assert.equal(
            captured[0].ephemPrivateKey.equals(captured[1].ephemPrivateKey),
            false,
            `${site}: acquire ephemeral keys must differ for the same lclHash: ${captured[0].ephemPrivateKey.toString('hex')} vs ${captured[1].ephemPrivateKey.toString('hex')}`
        );
        notSliceOrHash(captured[0].iv, FIXED_LCL_HASH, 'acquire IV', site);
        notSliceOrHash(captured[0].ephemPrivateKey, FIXED_LCL_HASH, 'acquire ephemeral key', site);
        notSliceOrHash(captured[1].iv, FIXED_LCL_HASH, 'acquire IV', site);
        notSliceOrHash(captured[1].ephemPrivateKey, FIXED_LCL_HASH, 'acquire ephemeral key', site);
        assert.equal(first.resultCode, 'tesSUCCESS', `${site}: acquireSubmit resultCode`);
        assert.equal(second.resultCode, 'tesSUCCESS', `${site}: acquireSubmit resultCode`);
    }
    finally {
        evernode.TenantClient.prototype.connect = originals.connect;
        evernode.TenantClient.prototype.disconnect = originals.disconnect;
        evernode.TenantClient.prototype.getLeaseHost = originals.getLeaseHost;
        evernode.TenantClient.prototype.prepareAcquireLeaseTransaction = originals.prepare;
        evernode.XrplAccount.prototype.prepareBuyURIToken = originals.prepareBuy;
        evernode.EvernodeHelpers.getLeaseOffers = originals.getLeaseOffers;
        evernode.Defaults.set({ xrplApi: originals.defaults.xrplApi });
        process.chdir(previousCwd);
        fs.rmSync(workDir, { recursive: true, force: true });
    }
});
