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
    const savedForReplay = [];
    let prefillUsed = false;
    let nonUnlSent = false;
    const withhold = new Set(options.withhold || []);
    const noiseDone = { contribution: false, memo: false };

    function itemPhase(item) {
        const vote = parseVote(item.message);
        if (!vote || typeof vote.election !== 'string')
            return '';
        if (vote.election.startsWith('acquire_key_contribution'))
            return 'contribution';
        if (vote.election.startsWith('acquire_memo'))
            return 'memo';
        return '';
    }

    function missedContribution(receiverIndex, senderKey) {
        if (!Array.isArray(options.missContribution))
            return false;
        const senderIndex = indexOf.has(senderKey) ? indexOf.get(senderKey) : -1;
        return options.missContribution.some(rule => rule && rule.receiver === receiverIndex && rule.sender === senderIndex);
    }

    function deliver(batch) {
        publicKeys.forEach((receiver, receiverIndex) => {
            const ordered = options.alignedDelivery ? batch : rotate(batch, receiverIndex);
            for (const item of ordered) {
                if (!feeds[receiver])
                    continue;
                const phase = itemPhase(item);
                if (phase === 'contribution' && missedContribution(receiverIndex, item.publicKey))
                    continue;
                const senderIndex = indexOf.has(item.publicKey) ? indexOf.get(item.publicKey) : -1;
                const senderKey = options.upperCaseSenders && typeof item.publicKey === 'string'
                    ? item.publicKey.toUpperCase()
                    : (options.mixedCaseSender && senderIndex === publicKeys.length - 1 && typeof item.publicKey === 'string'
                        ? item.publicKey.toUpperCase()
                        : item.publicKey);
                const sender = item.undefinedSender ? undefined : { publicKey: senderKey, activeOn: 1 };
                feeds[receiver](sender, Buffer.from(item.message));
            }
        });
    }

    function noiseVotes(election, count) {
        const foreign = 'ed' + 'ab'.repeat(32);
        const items = [];
        for (let index = 0; index < count; index++) {
            items.push({
                publicKey: foreign,
                message: encodeVote({ _evpType: 'unlVote', election, data: 'ab'.repeat(32) })
            });
            items.push({
                publicKey: foreign,
                message: encodeVote({ _evpType: 'unlVote', election, data: 'cd'.repeat(32) }),
                undefinedSender: true
            });
        }
        return items;
    }

    function flush() {
        const batch = pending.splice(0, pending.length);
        sent.clear();
        if (!prefillUsed && Array.isArray(options.prefill) && options.prefill.length) {
            prefillUsed = true;
            deliver(options.prefill.concat(batch));
            return;
        }
        const phase = batch.length ? itemPhase(batch[0]) : '';
        const election = phase ? (parseVote(batch[0].message) || {}).election : '';
        if (phase && options.earlyNoise === phase && !noiseDone[phase]) {
            noiseDone[phase] = true;
            // Noise is its own turn. The honest batch is a later timer, after the
            // elector has already considered the non-UNL messages.
            deliver(noiseVotes(election, publicKeys.length));
            setTimeout(() => deliver(batch), 0);
            return;
        }
        const duplicatePhase = options.lateHonestDuplicate;
        if (phase && batch.length && (duplicatePhase === true || duplicatePhase === phase)) {
            // The honest batch is one turn. One sender's second vote is the next
            // turn, after the elector has considered the n distinct votes.
            deliver(batch);
            const extra = batch[0];
            setTimeout(() => deliver([extra]), 0);
            return;
        }
        deliver(batch);
    }

    return {
        wire,
        replayStale() {
            if (savedForReplay.length === 0)
                return;
            deliver(savedForReplay.map(item => ({ publicKey: item.publicKey, message: Buffer.from(item.message) })));
        },
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
            const acquireVote = vote && typeof vote.election === 'string'
                && (vote.election.startsWith('acquire_key_contribution') || vote.election.startsWith('acquire_memo'));
            const dropMemo = vote && typeof vote.election === 'string' && vote.election.startsWith('acquire_memo')
                && Array.isArray(options.dropMemo) && options.dropMemo.includes(senderIndex);
            const dropWithheld = acquireVote && withhold.has(senderIndex);
            if (options.lateReplay && vote && typeof vote.election === 'string' && vote.election.startsWith('acquire_key_contribution'))
                savedForReplay.push({ publicKey, message: Buffer.from(payload) });
            if (!dropMemo && !dropWithheld) {
                const equivocate = options.equivocate && options.equivocate.index === senderIndex && vote
                    && typeof vote.election === 'string' && vote.election.startsWith('acquire_key_contribution')
                    && Array.isArray(options.equivocate.values);
                if (equivocate) {
                    for (const value of options.equivocate.values)
                        pending.push({ publicKey, message: encodeVote({ ...vote, data: value }) });
                } else {
                    pending.push({ publicKey, message: payload });
                }
                const doublePhase = options.doubleVote && options.doubleVote.phase;
                const doubleHere = options.doubleVote && options.doubleVote.index === senderIndex && vote && typeof vote.election === 'string'
                    && ((doublePhase === 'contribution' && vote.election.startsWith('acquire_key_contribution'))
                        || (doublePhase === 'memo' && vote.election.startsWith('acquire_memo')));
                if (doubleHere) {
                    const second = Buffer.from(payload);
                    if (options.doubleVote.different) {
                        const parsed = parseVote(second);
                        if (parsed)
                            parsed.data = options.doubleVote.different;
                        pending.push({ publicKey, message: parsed ? encodeVote(parsed) : second });
                    } else {
                        pending.push({ publicKey, message: second });
                    }
                }
                if (options.duplicateAll && acquireVote)
                    pending.push({ publicKey, message: Buffer.from(payload) });
            }
            if (!nonUnlSent && vote && options.nonUnlContribution && typeof vote.election === 'string' && vote.election.startsWith('acquire_key_contribution')) {
                nonUnlSent = true;
                pending.push({
                    publicKey: options.nonUnlKey || 'f'.repeat(64),
                    message: encodeVote({ ...vote, data: options.nonUnlContribution }),
                    undefinedSender: options.nonUnlUndefined === true
                });
                if (options.nonUnlAlsoUndefined)
                    pending.push({
                        publicKey: options.nonUnlKey || 'f'.repeat(64),
                        message: encodeVote({ ...vote, data: options.nonUnlUndefinedContribution || options.nonUnlContribution }),
                        undefinedSender: true
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

function partsAreWiped(ctx) {
    const scratch = ctx.acquireKeyScratch;
    if (!scratch || !Array.isArray(scratch.parts) || scratch.parts.length === 0)
        return false;
    return scratch.parts.every(part => Buffer.isBuffer(part) && isZero(part));
}

function namedBufferWiped(ctx, field) {
    const scratch = ctx.acquireKeyScratch;
    const value = scratch && scratch[field];
    return Buffer.isBuffer(value) && value.length > 0 && isZero(value);
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

function shapeUnl(publicKeys, selfKey, config) {
    const nodes = publicKeys.map(publicKey => ({ publicKey, activeOn: 1 }));
    if (config.unlFault === 'empty')
        return [];
    if (config.unlFault === 'missing-self')
        return nodes.filter(node => node.publicKey !== selfKey);
    if (config.unlFault === 'malformed')
        return [{ publicKey: 'not-an-ed-key', activeOn: 1 }].concat(nodes.slice(1));
    if (config.unlFault === 'duplicate')
        return nodes.concat([{ publicKey: nodes[0].publicKey, activeOn: 2 }]);
    if (config.unlFault === 'case-duplicate')
        return nodes.concat([{ publicKey: nodes[0].publicKey.toUpperCase(), activeOn: 2 }]);
    if (config.unlFault === 'upper-self') {
        return nodes.map(node => ({
            publicKey: node.publicKey === selfKey ? node.publicKey.toUpperCase() : node.publicKey,
            activeOn: node.activeOn
        }));
    }
    return nodes;
}

function installCipherLengthFault(config) {
    if (!config.cipherLengthFault)
        return () => { };
    const fault = config.cipherLengthFault;
    const secp = require('ripple-keypairs/dist/secp256k1');
    const originalCreateHash = crypto.createHash;
    const originalDerive = secp.derivePrivateKey;
    if (fault === 'iv8') {
        crypto.createHash = function (algorithm) {
            const hash = originalCreateHash.call(crypto, algorithm);
            if (algorithm !== 'sha256')
                return hash;
            const originalDigest = hash.digest.bind(hash);
            hash.digest = function () {
                const out = originalDigest();
                return out.length === 32 ? out.subarray(0, 8) : out;
            };
            return hash;
        };
    }
    if (fault === 'key33' || fault === 'key31') {
        secp.derivePrivateKey = function () {
            const scalar = originalDerive.apply(secp, arguments);
            const originalToArrayLike = scalar.toArrayLike.bind(scalar);
            scalar.toArrayLike = function () {
                const full = originalToArrayLike(Buffer, 'be', 32);
                if (fault === 'key33')
                    return Buffer.concat([Buffer.from([0xed]), full]);
                return full.subarray(0, 31);
            };
            return scalar;
        };
    }
    return () => {
        crypto.createHash = originalCreateHash;
        secp.derivePrivateKey = originalDerive;
    };
}

function installEphemeralKeyFault(config) {
    if (config.ephemeralKeyFault !== 'zero' && config.ephemeralKeyFault !== 'order')
        return () => { };
    const secp = require('ripple-keypairs/dist/secp256k1');
    const originalDerive = secp.derivePrivateKey;
    const forced = config.ephemeralKeyFault === 'order' ? SECP256K1_ORDER : Buffer.alloc(32, 0);
    secp.derivePrivateKey = function () {
        const scalar = originalDerive.apply(secp, arguments);
        scalar.toArrayLike = function () {
            return Buffer.from(forced);
        };
        return scalar;
    };
    return () => {
        secp.derivePrivateKey = originalDerive;
    };
}

const IV_DOMAIN = Buffer.from('everpocket-acquire-iv-v1');

function sawIvDomain(data) {
    return Buffer.isBuffer(data) && data.length === IV_DOMAIN.length && data.equals(IV_DOMAIN);
}

function installIvLengthFault(config) {
    if (config.ivLengthFault !== 'short')
        return () => { };
    const originalCreateHash = crypto.createHash;
    crypto.createHash = function (algorithm) {
        const hash = originalCreateHash.apply(crypto, arguments);
        if (algorithm !== 'sha256')
            return hash;
        let updates = 0;
        let track = false;
        const originalUpdate = hash.update.bind(hash);
        const originalDigest = hash.digest.bind(hash);
        hash.update = function (data) {
            updates += 1;
            if (updates === 1 && sawIvDomain(data))
                track = true;
            return originalUpdate.apply(hash, arguments);
        };
        hash.digest = function () {
            const out = originalDigest.apply(hash, arguments);
            // Real digest, shortened. The length check sees these bytes.
            if (track && Buffer.isBuffer(out) && out.length >= 8)
                return out.subarray(0, 8);
            return out;
        };
        return hash;
    };
    return () => {
        crypto.createHash = originalCreateHash;
    };
}

function installDerivedKeyLengthFault(config) {
    const length = config.derivedKeyLength;
    if (length !== 0 && length !== 31 && length !== 33 && length !== 64)
        return () => { };
    const secp = require('ripple-keypairs/dist/secp256k1');
    const originalDerive = secp.derivePrivateKey;
    secp.derivePrivateKey = function () {
        const scalar = originalDerive.apply(secp, arguments);
        const originalToArrayLike = scalar.toArrayLike.bind(scalar);
        scalar.toArrayLike = function () {
            const full = originalToArrayLike(Buffer, 'be', 32);
            if (length === 0)
                return Buffer.alloc(0);
            if (length < 32)
                return full.subarray(0, length);
            if (length === 33)
                return Buffer.concat([Buffer.from([0xed]), full]);
            return Buffer.concat([full, full]);
        };
        return scalar;
    };
    return () => {
        secp.derivePrivateKey = originalDerive;
    };
}

function installTenantClientFault(config) {
    if (!config.failFirstTenantClient)
        return () => { };
    const Original = evernode.TenantClient;
    let used = false;
    function FaultingTenantClient(...args) {
        if (!used) {
            used = true;
            throw new Error('tenant client construction failed');
        }
        return new Original(...args);
    }
    FaultingTenantClient.prototype = Original.prototype;
    evernode.TenantClient = FaultingTenantClient;
    return () => {
        evernode.TenantClient = Original;
    };
}

function buffersAllZero(list) {
    return Array.isArray(list) && list.length > 0 && list.every(buffer => Buffer.isBuffer(buffer) && buffer.length > 0 && isZero(buffer));
}

function installPassThroughObserver(config, record) {
    if (!config.observeCrypto)
        return () => { };
    const secp = require('ripple-keypairs/dist/secp256k1');
    const originalCreateHash = crypto.createHash;
    const originalDerive = secp.derivePrivateKey;
    let expectAcquireSeed = false;
    crypto.createHash = function (algorithm) {
        record.hashes.push(algorithm);
        const hash = originalCreateHash.apply(crypto, arguments);
        if (algorithm !== 'sha256')
            return hash;
        let updates = 0;
        let track = false;
        const originalUpdate = hash.update.bind(hash);
        const originalDigest = hash.digest.bind(hash);
        hash.update = function (data) {
            updates += 1;
            if (updates === 1 && sawIvDomain(data))
                track = true;
            else if (track && updates === 2 && Buffer.isBuffer(data))
                record.joined.push(data);
            return originalUpdate.apply(hash, arguments);
        };
        hash.digest = function () {
            const out = originalDigest.apply(hash, arguments);
            if (track && Buffer.isBuffer(out)) {
                record.ivHashes.push(out);
                // The acquire seed is the next derivePrivateKey argument.
                expectAcquireSeed = true;
            }
            return out;
        };
        return hash;
    };
    secp.derivePrivateKey = function (seed) {
        record.derives += 1;
        if (expectAcquireSeed && Buffer.isBuffer(seed)) {
            record.seeds.push(seed);
            expectAcquireSeed = false;
        }
        return originalDerive.apply(secp, arguments);
    };
    return () => {
        crypto.createHash = originalCreateHash;
        secp.derivePrivateKey = originalDerive;
    };
}

async function buildCluster(config, ledger, definitions) {
    const nodeCount = config.nodeCount;
    const publicKeys = [];
    for (let index = 0; index < nodeCount; index++) {
        const body = crypto.randomBytes(32).toString('hex');
        publicKeys.push(config.bareUnlKeys ? body : ('ed' + body));
    }
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
        nonUnlUndefined: config.nonUnlUndefined,
        nonUnlAlsoUndefined: config.nonUnlAlsoUndefined,
        nonUnlUndefinedContribution: config.nonUnlUndefinedContribution,
        alignedDelivery: config.alignedDelivery,
        withhold: config.withhold,
        equivocate: config.equivocate,
        duplicateAll: config.duplicateAll,
        lateReplay: config.lateReplay,
        prefill,
        earlyNoise: config.earlyNoise,
        missContribution: config.missContribution,
        upperCaseSenders: config.upperCaseSenders,
        mixedCaseSender: config.mixedCaseSender,
        lateHonestDuplicate: config.lateHonestDuplicate
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
        const selfKey = publicKeys[index];
        const contractContext = {
            publicKey: selfKey,
            contractId: 'acquire-cluster',
            lclSeqNo: 42,
            lclHash: config.lclHash,
            timestamp: 1,
            unl: {
                send: (message) => bus.send(selfKey, message)
            }
        };
        if (config.unlFault !== 'absent') {
            contractContext.unl.list = () => {
                if (config.unlFault === 'throw')
                    throw new Error(config.unlFaultMessage || 'contract unl failed');
                return shapeUnl(publicKeys, selfKey, config);
            };
        }
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
        node.xrpl.xrplAcc.getAccountObjects = async () => [{
            LedgerEntryType: 'SignerList',
            SignerQuorum: signerListInfo.signerQuorum,
            SignerEntries: signerList.map(signer => ({
                SignerEntry: {
                    Account: signer.account,
                    SignerWeight: signer.weight
                }
            }))
        }];
        await node.xrpl.loadSignerList();
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
    // Pass-through: record the exact buffers the cipher receives, then return its real result.
    evernode.TenantClient.prototype.prepareAcquireLeaseTransaction = async function (hostAddress, requirement, options = {}) {
        if (options && options.iv)
            cipherBuffers.push(options.iv);
        if (options && options.ephemPrivateKey)
            cipherBuffers.push(options.ephemPrivateKey);
        return originalPrepare.call(this, hostAddress, requirement, options);
    };
    const uncaught = [];
    let notifyCipherRejection = null;
    const noteUncaught = (kind, error) => {
        uncaught.push({ kind, message: error && (error.message || String(error)) });
    };
    const onException = (error) => noteUncaught('uncaughtException', error);
    const onRejection = (reason) => {
        noteUncaught('unhandledRejection', reason);
        if (notifyCipherRejection)
            notifyCipherRejection(reason);
    };
    if (config.recordUncaught !== false) {
        process.on('uncaughtException', onException);
        process.on('unhandledRejection', onRejection);
    }

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
        const cryptoObservations = { hashes: [], derives: 0, joined: [], seeds: [], ivHashes: [] };
        const restoreCipherFault = installCipherLengthFault(config);
        const restoreKeyFault = installEphemeralKeyFault(config);
        const restoreIvFault = installIvLengthFault(config);
        const restoreDerivedLength = installDerivedKeyLengthFault(config);
        const restoreClientFault = installTenantClientFault(config);
        const restoreObserver = installPassThroughObserver(config, cryptoObservations);
        let timedOut = false;
        for (let round = 0; round < roundCount; round++) {
            if (round > 0 && config.lateReplay)
                cluster.bus.replayStale();
            const beforeLanded = ledger.landed.length;
            const beforeWire = cluster.bus.wire.length;
            const beforeSubmitted = ledger.submissions.length;
            const oneAcquire = async (node, index) => {
                if (offline.has(index))
                    return { hash: null, error: null, result: null, skipped: true };
                const instanceCfg = { ...(config.instanceCfg || DEFAULT_INSTANCE) };
                if (config.swapNode === index)
                    instanceCfg.ownerPubkey = `ed${'ab'.repeat(32)}`;
                try {
                    if (parentPort)
                        parentPort.postMessage({ event: 'acquireSubmit' });
                    const pending = node.evernode.acquireSubmit(HOST_ADDRESS, leaseOffer(), messageKey, {
                        instanceCfg,
                        voteElectorOptions: { timeout: config.voteTimeout || 800 }
                    });
                    const settled = pending.then(value => ({ value }), error => ({ error }));
                    const racers = [settled];
                    let timer = null;
                    if (Number.isFinite(config.acquireDeadline)) {
                        racers.push(new Promise(resolve => {
                            timer = setTimeout(() => resolve({ deadline: true }), config.acquireDeadline);
                        }));
                    }
                    if (config.ivLengthFault) {
                        racers.push(new Promise(resolve => {
                            notifyCipherRejection = (reason) => resolve({ cipherRejection: reason });
                        }));
                    }
                    const raced = await Promise.race(racers);
                    if (timer)
                        clearTimeout(timer);
                    notifyCipherRejection = null;
                    if (raced.deadline) {
                        timedOut = true;
                        return { hash: null, error: 'acquire did not finish', result: null };
                    }
                    if (raced.cipherRejection) {
                        const reason = raced.cipherRejection;
                        return { hash: null, error: reason && (reason.stack || reason.message || String(reason)), result: null };
                    }
                    if (raced.error)
                        return { hash: null, error: raced.error && (raced.error.stack || raced.error.message || String(raced.error)), result: null };
                    return { hash: raced.value && raced.value.hash, error: null, result: raced.value };
                } catch (error) {
                    notifyCipherRejection = null;
                    return { hash: null, error: error && (error.stack || error.message || String(error)), result: null };
                }
            };
            const outcomes = await Promise.all(cluster.nodes.map(async (node, index) => {
                if (!config.concurrent)
                    return oneAcquire(node, index);
                const [first, second] = await Promise.all([oneAcquire(node, index), oneAcquire(node, index)]);
                return {
                    hash: first.hash || second.hash,
                    error: null,
                    errors: [first.error, second.error].filter(Boolean),
                    result: first.result || second.result,
                    skipped: first.skipped && second.skipped
                };
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
                if (Array.isArray(outcome.errors)) {
                    for (const errorText of outcome.errors)
                        errors.push(errorText);
                } else if (outcome.error) {
                    errors.push(outcome.error);
                }
                returns.push(outcome.result == null ? null : JSON.stringify(outcome.result));
            }
            rounds.push({
                hashes: outcomes.map(outcome => outcome.hash),
                landed: landedNow.length,
                memo,
                plain,
                contributions: readContributions(cluster.bus.wire.slice(beforeWire))
            });
        }
        restoreCipherFault();
        restoreKeyFault();
        restoreIvFault();
        restoreDerivedLength();
        restoreClientFault();
        restoreObserver();

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
        const cipherIvs = cipherBuffers.filter(buffer => Buffer.isBuffer(buffer) && buffer.length === 16);
        const overlaps = (left, right) => {
            if (left.buffer !== right.buffer)
                return false;
            const leftStart = left.byteOffset;
            const rightStart = right.byteOffset;
            return leftStart < rightStart + right.byteLength && rightStart < leftStart + left.byteLength;
        };
        const ivDetachedFromHash = cryptoObservations.ivHashes.length > 0 && cipherIvs.length > 0
            && cipherIvs.every(iv => cryptoObservations.ivHashes.every(hash => !overlaps(iv, hash)));
        const snapshots = fills.wiped.filter(buffer => buffer.length === 16 || buffer.length === 32).map(buffer => buffer.toString('hex'));
        return {
            attempts: ledger.attempts,
            landed: ledger.landed.length,
            hashes: ledger.landed.map(entry => entry.hash),
            errors,
            rounds,
            contributions,
            scratchZero: contexts.every(scratchIsWiped),
            partsZero: contexts.every(partsAreWiped),
            joinedZero: contexts.length > 0 && contexts.every(ctx => namedBufferWiped(ctx, 'joined')),
            seedZero: contexts.length > 0 && contexts.every(ctx => namedBufferWiped(ctx, 'seed')),
            ivHashZero: contexts.length > 0 && contexts.every(ctx => namedBufferWiped(ctx, 'ivHash')),
            uncaught,
            timedOut,
            inFlightClear: contexts.length > 0 && contexts.every(ctx => ctx.acquireInFlight === false),
            cryptoObservations: {
                hashes: cryptoObservations.hashes,
                derives: cryptoObservations.derives,
                originalsZero: {
                    joined: buffersAllZero(cryptoObservations.joined),
                    seed: buffersAllZero(cryptoObservations.seeds),
                    ivHash: buffersAllZero(cryptoObservations.ivHashes)
                }
            },
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
            ivDetachedFromHash,
            snapshots
        };
    } finally {
        evernode.TenantClient.prototype.prepareAcquireLeaseTransaction = originalPrepare;
        if (config.recordUncaught !== false) {
            process.off('uncaughtException', onException);
            process.off('unhandledRejection', onRejection);
        }
        fills.restore();
        stdio.restore();
    }
}

const { isMainThread, workerData, parentPort } = require('worker_threads');

function publish(config) {
    run(config).then((report) => {
        fs.writeFileSync(config.resultPath, JSON.stringify(report));
        // A rejected cipher promise can stay pending. The report is already on disk.
        process.exit(0);
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
}

// A worker cannot chdir, so the out-of-range test passes workerData and holds
// the parent cwd. Child processes still pass the config on argv.
if (!isMainThread && workerData)
    publish(workerData);
else if (isMainThread && process.argv[2])
    publish(JSON.parse(process.argv[2]));
