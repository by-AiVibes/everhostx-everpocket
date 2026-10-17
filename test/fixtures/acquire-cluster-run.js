'use strict';

// Drives a real acquireSubmit through HotPocket votes, multisign, and evernode
// encryption. The only stand-ins are the XRPL network and the NPL file descriptor.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const evernode = require('evernode-js-client');
const kp = require('ripple-keypairs');
const codec = require('ripple-binary-codec');
const elliptic = require('elliptic');

const HotPocketContext = require('../../dist/context/HotPocketContext').default;
const XrplContext = require('../../dist/context/XrplContext').default;
const EvernodeContext = require('../../dist/context/EvernodeContext').default;
const MultiSigner = require('../../dist/multi-sign/MultiSigner').default;

const IV_LENGTH = 16;
const EPHEMERAL_PUBLIC_KEY_LENGTH = 65;
const ENCRYPTED_MEMO_FLAG = 0x01;
const NETWORK_ID = 21337;
const TENANT_ADDRESS = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
const HOST_ADDRESS = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe';
const LEASE_OFFER_INDEX = 'A1B2C3D4E5F60718293A4B5C6D7E8F90112233445566778899AABBCCDDEEFF00';
const SECP256K1_ORDER = Buffer.from('fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141', 'hex');
const ec = new elliptic.ec('secp256k1');

const DEFAULT_INSTANCE = {
    ownerPubkey: 'ed3b4f907632e222987809a35e8ea55ed3b5d2e406b7d230a5e6f39a5e9834bafb',
    contractId: 'dc411912-bcdd-4f73-af43-32ec45844b9a',
    image: 'evernodedev/sashimono:hp.udpvisa-test-0.0.1-ubt.20.04-njs.20',
    config: {}
};

function isZero(buffer) {
    for (const byte of buffer)
        if (byte !== 0)
            return false;
    return true;
}

function uncompressedPublicKey(privateKey) {
    if (!Buffer.isBuffer(privateKey) || privateKey.length !== 32)
        return null;
    if (privateKey.compare(Buffer.alloc(32)) <= 0 || privateKey.compare(SECP256K1_ORDER) >= 0)
        return null;
    try {
        return Buffer.from(ec.keyFromPrivate(privateKey).getPublic(false, 'array'));
    } catch (error) {
        return null;
    }
}

function loadDefinitions() {
    const definitionsJson = JSON.parse(fs.readFileSync(path.join(__dirname, 'xahau-definitions.json'), 'utf8'));
    return new codec.XrplDefinitions(definitionsJson);
}

function rotate(batch, offset) {
    return batch.map((_, index) => batch[(index + offset) % batch.length]);
}

function parseVote(payload) {
    try {
        return JSON.parse(Buffer.from(payload).toString());
    } catch (error) {
        return null;
    }
}

function encodeVote(vote) {
    return Buffer.from(JSON.stringify(vote));
}

function createVoteBus(publicKeys, feeds, options = {}) {
    const offline = new Set(options.offline || []);
    const online = publicKeys.filter((_, index) => !offline.has(index));
    const indexOf = new Map(publicKeys.map((key, index) => [key, index]));
    const pending = [];
    const sent = new Set();
    const wire = [];
    let prefillUsed = false;
    let nonUnlSent = false;

    function deliver(batch) {
        publicKeys.forEach((receiver, receiverIndex) => {
            const ordered = options.alignedDelivery ? batch : rotate(batch, receiverIndex);
            for (const item of ordered) {
                if (feeds[receiver])
                    feeds[receiver]({ publicKey: item.publicKey }, Buffer.from(item.message));
            }
        });
    }

    function flush() {
        const batch = pending.splice(0, pending.length);
        sent.clear();
        if (!prefillUsed && Array.isArray(options.prefill) && options.prefill.length) {
            prefillUsed = true;
            deliver(options.prefill.concat(batch));
        } else {
            deliver(batch);
        }
    }

    return {
        wire,
        send(publicKey, message) {
            const original = Buffer.from(message);
            wire.push(Buffer.from(original));
            let payload = Buffer.from(original);
            const vote = parseVote(payload);
            const senderIndex = indexOf.has(publicKey) ? indexOf.get(publicKey) : -1;
            if (vote && typeof vote.election === 'string' && vote.election.startsWith('acquire_key_contribution')) {
                if (Array.isArray(options.fixedContributions) && senderIndex >= 0 && options.fixedContributions[senderIndex])
                    vote.data = options.fixedContributions[senderIndex];
                if (options.malformedIndex === senderIndex)
                    vote.data = 'aa';
                payload = encodeVote(vote);
            }
            if (vote && options.tamperMemoSets && typeof vote.election === 'string' && vote.election.startsWith('acquire_memo')) {
                try {
                    const body = JSON.parse(vote.data);
                    if (body && typeof body.memo === 'string' && Array.isArray(body.contributors)) {
                        body.contributors = [String(senderIndex)];
                        vote.data = JSON.stringify(body);
                        payload = encodeVote(vote);
                    }
                } catch (error) {
                    payload = Buffer.from(original);
                }
            }
            sent.add(publicKey);
            const dropMemo = vote && typeof vote.election === 'string' && vote.election.startsWith('acquire_memo')
                && Array.isArray(options.dropMemo) && options.dropMemo.includes(senderIndex);
            if (!dropMemo) {
                pending.push({ publicKey, message: payload });
                const doublePhase = options.doubleVote && options.doubleVote.phase;
                const doubleHere = options.doubleVote && options.doubleVote.index === senderIndex && vote && typeof vote.election === 'string'
                    && ((doublePhase === 'contribution' && vote.election.startsWith('acquire_key_contribution'))
                        || (doublePhase === 'memo' && vote.election.startsWith('acquire_memo')));
                if (doubleHere)
                    pending.push({ publicKey, message: Buffer.from(payload) });
            }
            if (!nonUnlSent && vote && options.nonUnlContribution && typeof vote.election === 'string' && vote.election.startsWith('acquire_key_contribution')) {
                nonUnlSent = true;
                pending.push({
                    publicKey: options.nonUnlKey || 'f'.repeat(64),
                    message: encodeVote({ ...vote, data: options.nonUnlContribution })
                });
            }
            if (sent.size === online.length)
                flush();
            return Promise.resolve();
        }
    };
}

function createLedger(definitions) {
    const landed = [];
    const submissions = [];
    let attempts = 0;

    function canonical(tx) {
        const copy = { ...tx, SigningPubKey: '' };
        delete copy.Signers;
        return copy;
    }

    function signaturesValid(tx) {
        if (!Array.isArray(tx.Signers) || tx.Signers.length === 0)
            return false;
        const unsigned = canonical(tx);
        for (const entry of tx.Signers) {
            const signer = entry && entry.Signer;
            if (!signer)
                return false;
            const encoded = codec.encodeForMultisigning(unsigned, signer.Account, definitions);
            if (!kp.verify(encoded, signer.TxnSignature, signer.SigningPubKey))
                return false;
        }
        return true;
    }

    function hashOf(tx) {
        const blob = codec.encode({ ...tx, SigningPubKey: tx.SigningPubKey || '' }, definitions);
        return crypto.createHash('sha512').update(Buffer.from(blob, 'hex')).digest('hex').slice(0, 64).toUpperCase();
    }

    return {
        landed,
        submissions,
        get attempts() {
            return attempts;
        },
        async submitMultisigned(tx) {
            attempts += 1;
            const lastLedgerSequence = tx.LastLedgerSequence;
            if (!signaturesValid(tx)) {
                submissions.push({ hash: '', tx, code: 'tefBAD_SIGNATURE' });
                return {
                    result: {
                        engine_result: 'tefBAD_SIGNATURE',
                        tx_json: { hash: '', LastLedgerSequence: lastLedgerSequence }
                    }
                };
            }
            const hash = hashOf(tx);
            const existing = landed.find(entry => entry.hash === hash);
            if (existing) {
                submissions.push({ hash, tx, code: 'tefALREADY' });
                return {
                    result: {
                        engine_result: 'tefALREADY',
                        tx_json: { hash, LastLedgerSequence: lastLedgerSequence }
                    }
                };
            }
            landed.push({ hash, tx });
            submissions.push({ hash, tx, code: 'tesSUCCESS' });
            return {
                result: {
                    engine_result: 'tesSUCCESS',
                    tx_json: { hash, LastLedgerSequence: lastLedgerSequence }
                }
            };
        }
    };
}

function createXrplHelper(definitions) {
    return {
        sign(tx, secret) {
            const pair = kp.deriveKeypair(secret);
            const account = kp.deriveAddress(pair.publicKey);
            const toSign = { ...tx, SigningPubKey: '' };
            const encoded = codec.encodeForMultisigning(toSign, account, definitions);
            const signature = kp.sign(encoded, pair.privateKey);
            const signedTx = {
                ...toSign,
                Signers: [{
                    Signer: {
                        Account: account,
                        SigningPubKey: pair.publicKey,
                        TxnSignature: signature
                    }
                }]
            };
            return { tx_blob: codec.encode(signedTx, definitions) };
        },
        decode(blob) {
            return codec.decode(blob, definitions);
        }
    };
}

function installNetworkStubs(hostAccount) {
    const originals = {
        connect: evernode.TenantClient.prototype.connect,
        disconnect: evernode.TenantClient.prototype.disconnect,
        getLeaseHost: evernode.TenantClient.prototype.getLeaseHost,
        prepareBuyURIToken: evernode.XrplAccount.prototype.prepareBuyURIToken,
        getLeaseOffers: evernode.EvernodeHelpers.getLeaseOffers
    };
    evernode.TenantClient.prototype.connect = async () => true;
    evernode.TenantClient.prototype.disconnect = async () => { };
    evernode.TenantClient.prototype.getLeaseHost = async () => hostAccount;
    evernode.EvernodeHelpers.getLeaseOffers = async () => [leaseOffer()];
    evernode.XrplAccount.prototype.prepareBuyURIToken = async function (uriToken, memos = null, options = {}) {
        const tx = {
            Account: this.address,
            TransactionType: 'URITokenBuy',
            Amount: uriToken.Amount,
            URITokenID: uriToken.index,
            Fee: '10',
            NetworkID: NETWORK_ID
        };
        if (memos)
            tx.Memos = evernode.TransactionHelper.formatMemos(memos);
        if (options.hookParams)
            tx.HookParameters = evernode.TransactionHelper.formatHookParams(options.hookParams);
        return tx;
    };
    return originals;
}

function leaseOffer() {
    return {
        Flags: 1,
        Issuer: HOST_ADDRESS,
        Owner: HOST_ADDRESS,
        Amount: {
            currency: 'EVR',
            issuer: TENANT_ADDRESS,
            value: '1'
        },
        index: LEASE_OFFER_INDEX,
        URI: '6576726C65617365'
    };
}

function memoMaterial(tx) {
    const memos = evernode.TransactionHelper.deserializeMemos(tx.Memos);
    const wrapped = Buffer.from(memos[0].data, 'base64');
    const encrypted = wrapped.subarray(1);
    return {
        type: memos[0].type,
        flag: wrapped[0],
        iv: Buffer.from(encrypted.subarray(IV_LENGTH === 16 ? EPHEMERAL_PUBLIC_KEY_LENGTH : 0, EPHEMERAL_PUBLIC_KEY_LENGTH + IV_LENGTH)),
        pub: Buffer.from(encrypted.subarray(0, EPHEMERAL_PUBLIC_KEY_LENGTH)),
        encrypted
    };
}

function readContributions(wire) {
    const found = [];
    for (const message of wire) {
        let vote;
        try {
            vote = JSON.parse(message.toString());
        } catch (error) {
            continue;
        }
        if (vote && typeof vote.election === 'string' && vote.election.startsWith('acquire_key_contribution') && typeof vote.data === 'string')
            found.push(vote.data.toLowerCase());
    }
    return [...new Set(found)];
}

function appears(haystack, hex) {
    const buffer = Buffer.from(hex, 'hex');
    const base64 = buffer.toString('base64');
    const jsonBytes = JSON.stringify(Array.from(buffer));
    return haystack.includes(hex) || haystack.includes(hex.toUpperCase()) || haystack.includes(base64) || haystack.includes(jsonBytes);
}

function textLeaksPrivateKey(text, publicKey) {
    const hexes = text.match(/[0-9a-fA-F]{64}/g) || [];
    for (const hex of hexes) {
        const derived = uncompressedPublicKey(Buffer.from(hex, 'hex'));
        if (derived && derived.equals(publicKey))
            return true;
    }
    const encoded = text.match(/[A-Za-z0-9+/]{43}=/g) || [];
    for (const value of encoded) {
        const decoded = Buffer.from(value, 'base64');
        if (decoded.length !== 32)
            continue;
        const derived = uncompressedPublicKey(decoded);
        if (derived && derived.equals(publicKey))
            return true;
    }
    return false;
}

function persistedState(contexts) {
    let text = '';
    const directory = process.cwd();
    for (const name of fs.readdirSync(directory)) {
        const filePath = path.join(directory, name);
        if (name === 'cluster-result.json' || !fs.statSync(filePath).isFile())
            continue;
        text += `\nFILE ${name}\n${fs.readFileSync(filePath)}`;
    }
    const parent = path.resolve(directory, '..');
    for (const name of fs.readdirSync(parent)) {
        if (!name.endsWith('.key') && !name.endsWith('.txt'))
            continue;
        text += `\nFILE ${name}\n${fs.readFileSync(path.join(parent, name))}`;
    }
    for (const ctx of contexts) {
        text += `\nPENDING ${JSON.stringify(ctx.getPendingAcquires())}`;
        text += `\nACQUIRED ${JSON.stringify(ctx.getAcquiredNodes())}`;
        text += `\nDATA ${JSON.stringify(ctx.acquireData)}`;
        text += `\nSCRATCH ${JSON.stringify(ctx.acquireKeyScratch)}`;
    }
    return text;
}

function scratchIsWiped(ctx) {
    const scratch = ctx.acquireKeyScratch;
    if (!scratch || !Buffer.isBuffer(scratch.iv) || !Buffer.isBuffer(scratch.ephemPrivateKey))
        return false;
    if (!isZero(scratch.iv) || !isZero(scratch.ephemPrivateKey))
        return false;
    if (scratch.contribution && !isZero(scratch.contribution))
        return false;
    return true;
}

function ivAliasesKey(iv, key) {
    if (!key || key.length < iv.length)
        return false;
    for (let offset = 0; offset + iv.length <= key.length; offset++) {
        if (iv.equals(key.subarray(offset, offset + iv.length)))
            return true;
    }
    return false;
}

function captureFill() {
    const wiped = [];
    const refs = [];
    const original = Buffer.prototype.fill;
    let capturing = false;
    Buffer.prototype.fill = function (value, ...rest) {
        if (!capturing && value === 0) {
            capturing = true;
            try {
                // Copy the view itself. Buffer.from(underlying, byteOffset, underlying.byteLength)
                // throws RangeError when the view starts at a non-zero offset.
                if (this.length === 16 || this.length === 32) {
                    wiped.push(Buffer.from(this));
                    refs.push(this);
                }
            } finally {
                capturing = false;
            }
        }
        return original.call(this, value, ...rest);
    };
    return {
        wiped,
        refs,
        restore() {
            Buffer.prototype.fill = original;
        }
    };
}

function captureStdio() {
    const captured = { out: '', err: '' };
    const original = {
        log: console.log,
        error: console.error,
        info: console.info,
        warn: console.warn,
        stdout: process.stdout.write,
        stderr: process.stderr.write
    };
    console.log = (...args) => { captured.out += `${args.join(' ')}\n`; };
    console.info = (...args) => { captured.out += `${args.join(' ')}\n`; };
    console.warn = (...args) => { captured.out += `${args.join(' ')}\n`; };
    console.error = (...args) => { captured.err += `${args.join(' ')}\n`; };
    process.stdout.write = (chunk) => { captured.out += chunk; return true; };
    process.stderr.write = (chunk) => { captured.err += chunk; return true; };
    return {
        captured,
        restore() {
            console.log = original.log;
            console.error = original.error;
            console.info = original.info;
            console.warn = original.warn;
            process.stdout.write = original.stdout;
            process.stderr.write = original.stderr;
        }
    };
}

async function buildCluster(config, ledger, definitions) {
    const nodeCount = config.nodeCount;
    const publicKeys = [];
    for (let index = 0; index < nodeCount; index++)
        publicKeys.push(crypto.randomBytes(32).toString('hex'));
    publicKeys.sort();
    const feeds = {};
    const prefill = Array.isArray(config.prefillContributions) ? publicKeys.map((publicKey, index) => ({
        publicKey,
        message: Buffer.from(JSON.stringify({
            _evpType: 'unlVote',
            election: 'acquire_key_contribution0',
            data: config.prefillContributions[index]
        }))
    })) : [];
    const bus = createVoteBus(publicKeys, feeds, {
        offline: config.offline || [],
        fixedContributions: config.fixedContributions,
        malformedIndex: config.malformedIndex,
        tamperMemoSets: config.tamperMemoSets,
        dropMemo: config.dropMemo,
        doubleVote: config.doubleVote,
        nonUnlContribution: config.nonUnlContribution,
        nonUnlKey: config.nonUnlKey,
        alignedDelivery: config.alignedDelivery,
        prefill
    });
    const helper = createXrplHelper(definitions);
    const signerList = [];
    const signerKeys = publicKeys.map(() => {
        const secret = kp.generateSeed({ algorithm: 'ecdsa-secp256k1' });
        const pair = kp.deriveKeypair(secret);
        const account = kp.deriveAddress(pair.publicKey);
        signerList.push({ account, weight: 1 });
        return { account, secret };
    });
    // Default quorum is n so the locked tests still require every signer.
    // Liveness tests pass the on-ledger quorum the cluster harness chooses:
    // test/contract/src/contract.js:44 uses Math.floor(signerCount * signerWeight * 0.6)
    // with signerWeight 1, and XrplContext.loadSignerList copies that SignerQuorum
    // from the ledger object (src/context/XrplContext.ts:210).
    const signerListInfo = { signerQuorum: config.signerQuorum == null ? nodeCount : config.signerQuorum, signerList };
    const nodes = [];

    for (let index = 0; index < nodeCount; index++) {
        const contractContext = {
            publicKey: publicKeys[index],
            contractId: 'acquire-cluster',
            lclSeqNo: 42,
            lclHash: config.lclHash,
            timestamp: 1,
            unl: {
                list: () => publicKeys.map(publicKey => ({ publicKey })),
                send: (message) => bus.send(publicKeys[index], message)
            }
        };
        const hp = new HotPocketContext(contractContext);
        feeds[publicKeys[index]] = (sender, message) => hp.voteContext.feedUnlMessage(sender, message);
        const xrpl = new XrplContext(hp, TENANT_ADDRESS, null, {});
        const api = { ledgerIndex: 100, xrplHelper: helper };
        xrpl.xrplApi = api;
        xrpl.xrplAcc = {
            address: TENANT_ADDRESS,
            secret: null,
            xrplApi: api,
            getSequence: async () => 10,
            submitMultisigned: (tx) => ledger.submitMultisigned(tx)
        };
        xrpl.multiSigner = new MultiSigner(xrpl.xrplAcc);
        nodes.push({ hp, xrpl, signerKey: signerKeys[index] });
    }

    for (const node of nodes) {
        node.xrpl.multiSigner.setSigner(node.signerKey);
        node.xrpl.signerListInfo = signerListInfo;
        node.evernode = new EvernodeContext(node.xrpl);
    }
    return { nodes, bus, publicKeys };
}

async function run(config) {
    const definitions = loadDefinitions();
    const ledger = createLedger(definitions);
    const hostSeed = kp.generateSeed({ algorithm: 'ecdsa-secp256k1' });
    const hostPair = kp.deriveKeypair(hostSeed);
    const hostAccount = new evernode.XrplAccount(HOST_ADDRESS, null, { xrplApi: {} });
    hostAccount.getMessageKey = async () => hostPair.publicKey;
    const tenantSecret = kp.generateSeed({ algorithm: 'ecdsa-secp256k1' });
    const messageKey = kp.deriveKeypair(tenantSecret).publicKey;
    installNetworkStubs(hostAccount);
    const cipherBuffers = [];
    const originalPrepare = evernode.TenantClient.prototype.prepareAcquireLeaseTransaction;
    evernode.TenantClient.prototype.prepareAcquireLeaseTransaction = async function (hostAddress, requirement, options = {}) {
        if (options && options.iv)
            cipherBuffers.push(options.iv);
        if (options && options.ephemPrivateKey)
            cipherBuffers.push(options.ephemPrivateKey);
        return originalPrepare.call(this, hostAddress, requirement, options);
    };

    const stdio = captureStdio();
    const fills = captureFill();
    const rounds = [];
    const errors = [];
    const returns = [];
    let contexts = [];
    let publicKeys = [];
    try {
        const cluster = await buildCluster(config, ledger, definitions);
        publicKeys = cluster.publicKeys;
        contexts = cluster.nodes.map(node => node.evernode);
        const offline = new Set(config.offline || []);
        const roundCount = config.rounds || 1;
        for (let round = 0; round < roundCount; round++) {
            const beforeLanded = ledger.landed.length;
            const beforeSubmitted = ledger.submissions.length;
            const outcomes = await Promise.all(cluster.nodes.map(async (node, index) => {
                if (offline.has(index))
                    return { hash: null, error: null, result: null, skipped: true };
                const instanceCfg = { ...(config.instanceCfg || DEFAULT_INSTANCE) };
                if (config.swapNode === index)
                    instanceCfg.ownerPubkey = `ed${'ab'.repeat(32)}`;
                try {
                    const result = await node.evernode.acquireSubmit(HOST_ADDRESS, leaseOffer(), messageKey, {
                        instanceCfg,
                        voteElectorOptions: { timeout: config.voteTimeout || 800 }
                    });
                    return { hash: result && result.hash, error: null, result };
                } catch (error) {
                    return { hash: null, error: error && (error.stack || error.message || String(error)), result: null };
                }
            }));
            const landedNow = ledger.landed.slice(beforeLanded);
            const submittedNow = ledger.submissions.slice(beforeSubmitted);
            const sample = submittedNow.find(entry => entry.code === 'tesSUCCESS')
                || submittedNow.find(entry => entry.code === 'tefALREADY');
            let memo = null;
            let plain = null;
            if (sample && sample.tx && sample.tx.Memos) {
                const material = memoMaterial(sample.tx);
                memo = {
                    iv: material.iv.toString('hex'),
                    pub: material.pub.toString('hex'),
                    flag: material.flag,
                    type: material.type,
                    ivLength: material.iv.length,
                    pubLength: material.pub.length
                };
                try {
                    plain = await evernode.EncryptionHelper.decrypt(hostPair.privateKey, material.encrypted.toString('base64'));
                    if (plain === undefined)
                        plain = null;
                } catch (error) {
                    plain = null;
                }
            }
            for (const outcome of outcomes) {
                if (outcome.skipped)
                    continue;
                if (outcome.error)
                    errors.push(outcome.error);
                returns.push(outcome.result == null ? null : JSON.stringify(outcome.result));
            }
            rounds.push({
                hashes: outcomes.map(outcome => outcome.hash),
                landed: landedNow.length,
                memo,
                plain
            });
        }

        const contributions = readContributions(cluster.bus.wire);
        const persisted = persistedState(contexts);
        const stdioText = `${stdio.captured.out}\n${stdio.captured.err}`;
        const observedKeys = fills.wiped.filter(buffer => buffer.length === 32 && !isZero(buffer));
        for (const ctx of contexts) {
            const key = ctx.acquireKeyScratch && ctx.acquireKeyScratch.ephemPrivateKey;
            if (key && key.length === 32 && !isZero(key))
                observedKeys.push(Buffer.from(key));
        }
        let keyFound = false;
        let ivIsSliceOfEphemeralKey = false;
        let pubDerivedFromIv = false;
        let keyLeaked = false;
        let ivLogged = false;
        for (const round of rounds) {
            if (!round.memo)
                continue;
            const iv = Buffer.from(round.memo.iv, 'hex');
            const pub = Buffer.from(round.memo.pub, 'hex');
            const doubled = uncompressedPublicKey(Buffer.concat([iv, iv]));
            const hashed = uncompressedPublicKey(crypto.createHash('sha256').update(iv).digest());
            if ((doubled && doubled.equals(pub)) || (hashed && hashed.equals(pub)))
                pubDerivedFromIv = true;
            for (const key of observedKeys) {
                const derived = uncompressedPublicKey(key);
                if (derived && derived.equals(pub)) {
                    keyFound = true;
                    if (ivAliasesKey(iv, key))
                        ivIsSliceOfEphemeralKey = true;
                }
            }
            if (textLeaksPrivateKey(stdioText, pub) || textLeaksPrivateKey(persisted, pub))
                keyLeaked = true;
            const ivBase64 = iv.toString('base64');
            if (stdioText.toLowerCase().includes(round.memo.iv) || stdioText.includes(ivBase64))
                ivLogged = true;
        }
        const contributionLeaked = contributions.some(hex => appears(stdioText, hex) || appears(persisted, hex));
        const wipeCounts = {};
        for (const contribution of contributions) {
            const bytes = Buffer.from(contribution, 'hex');
            let count = 0;
            for (let index = 0; index < fills.wiped.length; index++) {
                if (fills.wiped[index].equals(bytes))
                    count += 1;
            }
            wipeCounts[contribution] = count;
        }
        const cipherWiped = cipherBuffers.length > 0 && cipherBuffers.every(buffer => Buffer.isBuffer(buffer) && isZero(buffer));
        const snapshots = fills.wiped.filter(buffer => buffer.length === 16 || buffer.length === 32).map(buffer => buffer.toString('hex'));
        return {
            attempts: ledger.attempts,
            landed: ledger.landed.length,
            hashes: ledger.landed.map(entry => entry.hash),
            errors,
            rounds,
            contributions,
            scratchZero: contexts.every(scratchIsWiped),
            keyFound,
            ivIsSliceOfEphemeralKey,
            pubDerivedFromIv,
            keyLeaked,
            ivLogged,
            contributionLeaked,
            messageKey,
            stdio: stdio.captured,
            persisted,
            publicKeys,
            returns,
            wipeCounts,
            cipherWiped,
            snapshots
        };
    } finally {
        evernode.TenantClient.prototype.prepareAcquireLeaseTransaction = originalPrepare;
        fills.restore();
        stdio.restore();
    }
}

const config = JSON.parse(process.argv[2]);
run(config).then((report) => {
    fs.writeFileSync(config.resultPath, JSON.stringify(report));
}).catch((error) => {
    const fatal = error && (error.stack || String(error));
    try {
        fs.writeFileSync(config.resultPath, JSON.stringify({ fatal, landed: 0, attempts: 0, errors: [fatal], rounds: [] }));
    } catch (writeError) {
        process.stderr.write(String(writeError));
    }
    process.stderr.write(fatal);
    process.exit(1);
});
