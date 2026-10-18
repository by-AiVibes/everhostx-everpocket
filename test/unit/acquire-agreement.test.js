'use strict';

const assert = require('node:assert/strict');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, test } = require('node:test');
const elliptic = require('elliptic');

const FIXED_LCL_HASH = '1a20bec21ef8038f32eaed2f4d1907b9f0bdcc02e05d1ee09b199ac13db6518a';
const HOST_ADDRESS = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe';
const LEASE_OFFER_INDEX = 'A1B2C3D4E5F60718293A4B5C6D7E8F90112233445566778899AABBCCDDEEFF00';
const IV_LENGTH = 16;
const SECP256K1_ORDER = Buffer.from('fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141', 'hex');
const HASH_ALGORITHMS = ['sha256', 'sha384', 'sha512'];
const ec = new elliptic.ec('secp256k1');
const RUNNER = path.join(__dirname, '../fixtures/acquire-cluster-run.js');
const INSTANCE_CFG = {
    ownerPubkey: 'ed3b4f907632e222987809a35e8ea55ed3b5d2e406b7d230a5e6f39a5e9834bafb',
    contractId: 'dc411912-bcdd-4f73-af43-32ec45844b9a',
    image: 'evernodedev/sashimono:hp.udpvisa-test-0.0.1-ubt.20.04-njs.20',
    config: {}
};

describe('acquire key material is agreed across nodes', { concurrency: 1 }, () => {
    test('3-node acquire lands exactly one transaction with the same hash', () => {
        const report = runCluster({ nodeCount: 3, rounds: 1 });
        assertOneTransaction(report);
    });

    test('5-node acquire lands exactly one transaction with the same hash', () => {
        const report = runCluster({ nodeCount: 5, rounds: 1 });
        assertOneTransaction(report);
    });

    test('restarted node produces a different acquire memo for the same lclHash', () => {
        const first = runCluster({ nodeCount: 3, rounds: 1 });
        const second = runCluster({ nodeCount: 3, rounds: 1 });
        assertOneTransaction(first);
        assertOneTransaction(second);
        const firstMemo = first.rounds[0].memo;
        const secondMemo = second.rounds[0].memo;
        assert.ok(firstMemo && secondMemo, 'restarted acquires must both submit a memo');
        assert.notEqual(
            firstMemo.iv,
            secondMemo.iv,
            `acquire IV read from the submitted memo must differ after restart: ${firstMemo.iv} vs ${secondMemo.iv}`
        );
        assert.notEqual(
            firstMemo.pub,
            secondMemo.pub,
            `acquire ephemeral pubkey read from the submitted memo must differ after restart: ${firstMemo.pub} vs ${secondMemo.pub}`
        );
    });

    test('ephemeral key and pre-share bytes never appear in output or state', () => {
        const report = runCluster({ nodeCount: 3, rounds: 1 });
        assertOneTransaction(report);
        const observed = `${report.stdio.out}\n${report.stdio.err}\n${report.persisted}`;
        assert.equal(report.contributionLeaked, false, 'acquire contribution must not appear in stdout, stderr, files, or state');
        assert.equal(report.keyLeaked, false, 'acquire ephemeral key must not appear in stdout, stderr, files, or state');
        assert.equal(report.ivLogged, false, 'acquire IV must not be logged to stdout or stderr');
        assert.equal(report.scratchZero, true, 'acquire ephemeral key must be wiped after submit');
        for (const contribution of report.contributions) {
            assert.equal(observed.includes(contribution), false, 'acquire contribution must not appear in stdout, stderr, files, or state');
        }
    });

    test('submitted memo IV and ephemeral key are independent', () => {
        const report = runCluster({ nodeCount: 3, rounds: 2 });
        assert.equal(report.rounds.length, 2, 'two acquire rounds must each return a memo');
        const memos = report.rounds.map(round => round.memo);
        assert.ok(memos[0] && memos[1], `each acquire round must submit a memo (${formatErrors(report)})`);
        for (const round of report.rounds) {
            assert.ok(round.hashes.every(hash => hash && hash === round.hashes[0]), `every node must return the same hash, got ${round.hashes.join(',')}`);
            assertDecryptBeforeFields(round, report.messageKey);
            assertMemoShape(round.memo);
            assertNotDerivedFromLclHash(round.memo);
        }
        assert.notEqual(memos[0].iv, memos[1].iv, `acquire IV read from the submitted memo must differ across rounds: ${memos[0].iv} vs ${memos[1].iv}`);
        assert.notEqual(memos[0].pub, memos[1].pub, `acquire ephemeral pubkey read from the submitted memo must differ across rounds: ${memos[0].pub} vs ${memos[1].pub}`);
        assert.equal(report.pubDerivedFromIv, false, 'acquire ephemeral key must not be derived from the IV');
        assert.equal(report.ivIsSliceOfEphemeralKey, false, 'acquire IV read from the memo must not equal a slice of the ephemeral private key');
        assert.equal(report.keyFound, true, 'acquire ephemeral key must be wiped after submit and checked against the memo');
        assert.equal(report.scratchZero, true, 'acquire ephemeral key must be wiped after submit');
    });

    test('swapped acquire config does not reach the ledger', () => {
        const report = runCluster({ nodeCount: 3, rounds: 1, swapNode: 0 });
        assert.equal(report.attempts, 0, `swapped acquire config must not reach the ledger, got ${report.attempts} submissions`);
        assert.equal(report.landed, 0, `swapped acquire config must not land, got ${report.landed}`);
    });

    test('Math.random is banned in src', () => {
        const eslint = path.join(__dirname, '../../node_modules/.bin/eslint');
        const config = path.join(__dirname, '../../.eslintrc.json');
        const fixture = runEslint(eslint, ['-c', config, '--no-ignore', path.join(__dirname, '../fixtures/math-random-banned.ts')]);
        assert.equal(fixture.status, 1, 'eslint must reject Math.random');
        assert.match(`${fixture.stdout}\n${fixture.stderr}`, /Math\.random/, 'eslint must report Math.random');
        const source = runEslint(eslint, ['-c', config, '--ext', '.ts', path.join(__dirname, '../../src')]);
        assert.equal(source.status, 0, `Math.random must not be used in src\n${source.stdout}\n${source.stderr}`);
    });
});

function runCluster(config) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acquire-agree-'));
    const workDir = path.join(root, 'work');
    fs.mkdirSync(workDir);
    const resultPath = path.join(root, 'cluster-result.json');
    const child = spawnSync(process.execPath, [RUNNER, JSON.stringify({
        lclHash: FIXED_LCL_HASH,
        voteTimeout: 800,
        instanceCfg: INSTANCE_CFG,
        resultPath,
        ...config
    })], {
        cwd: workDir,
        encoding: 'utf8',
        timeout: 60000
    });
    let report = null;
    if (fs.existsSync(resultPath))
        report = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    fs.rmSync(root, { recursive: true, force: true });
    if (!report)
        assert.fail(`cluster runner produced no report\n${child.stdout}\n${child.stderr}`);
    report.stdio = report.stdio || { out: '', err: '' };
    report.stdio.out += child.stdout || '';
    report.stdio.err += child.stderr || '';
    if (report.fatal)
        assert.fail(`cluster runner failed: ${report.fatal}`);
    if (report.timedOut)
        assert.fail('TIMEOUT: acquire did not finish');
    return report;
}

function runEslint(eslint, args) {
    const child = spawnSync(eslint, args, { encoding: 'utf8' });
    return { status: child.status, stdout: child.stdout || '', stderr: child.stderr || '' };
}

function assertOneTransaction(report) {
    assert.equal(
        report.landed,
        1,
        `exactly 1 acquire transaction must land, got ${report.landed} (${formatErrors(report)})`
    );
    const hashes = report.rounds[0] ? report.rounds[0].hashes : [];
    assert.ok(
        hashes.length >= 3 && hashes.every(hash => hash && hash === hashes[0]),
        `every node must return the same hash, got ${hashes.join(',')}`
    );
    assert.equal(hashes[0], report.hashes[0], 'returned hash must be the transaction the ledger recorded');
}

function assertDecryptBeforeFields(round, messageKey) {
    const plain = round.plain;
    assert.ok(plain != null, 'decrypt round-trip result must be non-null before field checks');
    assert.equal(plain.owner_pubkey, INSTANCE_CFG.ownerPubkey, 'decrypted owner_pubkey');
    assert.equal(plain.contract_id, INSTANCE_CFG.contractId, 'decrypted contract_id');
    assert.equal(plain.image, INSTANCE_CFG.image, 'decrypted image');
    assert.deepEqual(plain.config, INSTANCE_CFG.config, 'decrypted config');
    assert.equal(plain.messageKey, messageKey, 'decrypted messageKey');
}

function assertMemoShape(memo) {
    assert.equal(memo.flag, 0x01, 'acquire memo payload is encrypted');
    assert.equal(memo.type, 'evnAcquireLease', 'acquire memo type');
    assert.equal(memo.ivLength, IV_LENGTH, `acquire IV length read from the submitted memo, got ${memo.ivLength}`);
    assert.equal(memo.pubLength, 65, `acquire ephemeral pubkey length read from the submitted memo, got ${memo.pubLength}`);
    assert.equal(memo.pub.slice(0, 2), '04', 'acquire ephemeral pubkey read from the submitted memo must be uncompressed');
    assert.notEqual(memo.iv, '00'.repeat(IV_LENGTH), 'acquire IV read from the submitted memo must not be all zeros');
}

function assertNotDerivedFromLclHash(memo) {
    const iv = Buffer.from(memo.iv, 'hex');
    const pub = Buffer.from(memo.pub, 'hex');
    const lcl = Buffer.from(FIXED_LCL_HASH, 'hex');
    const reversed = Buffer.from(lcl).reverse();
    const bases = [
        ['lclHash', lcl],
        ['reversed lclHash', reversed],
        ['lclHash utf8', Buffer.from(FIXED_LCL_HASH, 'utf8')]
    ];
    for (const algorithm of HASH_ALGORITHMS) {
        bases.push([`${algorithm}(lclHash)`, crypto.createHash(algorithm).update(lcl).digest()]);
        bases.push([`${algorithm}(lclHash utf8)`, crypto.createHash(algorithm).update(FIXED_LCL_HASH, 'utf8').digest()]);
        bases.push([`${algorithm}(lclHash|host|offer)`, crypto.createHash(algorithm).update(Buffer.concat([
            lcl,
            Buffer.from(HOST_ADDRESS),
            Buffer.from(LEASE_OFFER_INDEX)
        ])).digest()]);
    }
    for (const [label, base] of bases) {
        const slice = base.subarray(0, iv.length);
        assert.ok(!(slice.length === iv.length && iv.equals(slice)), `acquire IV read from the submitted memo must not be a slice of ${label}`);
        const key = base.subarray(0, 32);
        const derived = uncompressedPublicKey(key);
        if (derived)
            assert.ok(!pub.equals(derived), `acquire ephemeral pubkey read from the submitted memo must not be the public key of ${label}`);
    }
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

function formatErrors(report) {
    return (report.errors || []).slice(0, 2).join(' | ');
}
