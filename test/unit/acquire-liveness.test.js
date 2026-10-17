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
const IV_DOMAIN = Buffer.from('everpocket-acquire-iv-v1');
const KEY_DOMAIN = Buffer.from('everpocket-acquire-ephemeral-v1');
const SECP256K1_ORDER = Buffer.from('fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141', 'hex');
const RUNNER = path.join(__dirname, '../fixtures/acquire-cluster-run.js');
const ec = new elliptic.ec('secp256k1');

const C0 = '11'.repeat(32);
const C1 = '22'.repeat(32);
const C2 = '33'.repeat(32);
const C3 = '44'.repeat(32);
const C4 = '55'.repeat(32);
const C5 = '66'.repeat(32);

describe('acquire votes are per sender and live at ceil(2n/3)', { concurrency: 1 }, () => {
    test('1 of 3 nodes offline lands exactly one transaction with the same hash', () => {
        const report = runCluster({ nodeCount: 3, offline: [2], signerQuorum: ledgerQuorum(3), voteTimeout: 200 });
        assertLanded(report, 2);
    });

    test('1 of 5 nodes offline lands exactly one transaction with the same hash', () => {
        const report = runCluster({ nodeCount: 5, offline: [4], signerQuorum: ledgerQuorum(5), voteTimeout: 200 });
        assertLanded(report, 4);
    });

    test('2 of 5 nodes offline aborts before multisign', () => {
        const report = runCluster({ nodeCount: 5, offline: [3, 4], signerQuorum: ledgerQuorum(5), voteTimeout: 200 });
        assertAborted(report, /acquire key agreement below threshold/);
    });

    test('2 of 3 nodes offline aborts before multisign', () => {
        const report = runCluster({ nodeCount: 3, offline: [1, 2], signerQuorum: ledgerQuorum(3), voteTimeout: 200 });
        assertAborted(report, /acquire key agreement below threshold/);
    });

    test('2 of 6 nodes offline still lands one transaction', () => {
        const report = runCluster({ nodeCount: 6, offline: [4, 5], signerQuorum: ledgerQuorum(6), voteTimeout: 200 });
        assertLanded(report, 4);
    });

    test('a double contribution vote aborts with 0 attempts', () => {
        const report = runCluster({ nodeCount: 3, doubleVote: { phase: 'contribution', index: 0 }, voteTimeout: 200 });
        assertAborted(report, /acquire vote rejected: double vote/);
    });

    test('a double memo vote aborts with 0 attempts', () => {
        const report = runCluster({ nodeCount: 3, doubleVote: { phase: 'memo', index: 1 }, voteTimeout: 200 });
        assertAborted(report, /acquire vote rejected: double vote/);
    });

    test('a double vote with another node offline aborts with 0 attempts', () => {
        const report = runCluster({
            nodeCount: 3,
            offline: [2],
            doubleVote: { phase: 'contribution', index: 0 },
            signerQuorum: ledgerQuorum(3),
            voteTimeout: 200
        });
        assertAborted(report, /acquire vote rejected: double vote/);
    });

    test('one withheld memo vote on 3 nodes still lands one transaction', () => {
        const report = runCluster({ nodeCount: 3, dropMemo: [2], signerQuorum: ledgerQuorum(3), voteTimeout: 200 });
        assertLanded(report, 3);
    });

    test('two withheld memo votes on 3 nodes abort', () => {
        const report = runCluster({ nodeCount: 3, dropMemo: [1, 2], signerQuorum: ledgerQuorum(3), voteTimeout: 200 });
        assertAborted(report, /acquire memo agreement below threshold/);
    });

    test('two withheld memo votes on 5 nodes abort', () => {
        const report = runCluster({ nodeCount: 5, dropMemo: [3, 4], signerQuorum: ledgerQuorum(5), voteTimeout: 200 });
        assertAborted(report, /acquire memo agreement below threshold/);
    });

    test('two withheld memo votes on 6 nodes still land one transaction', () => {
        const report = runCluster({ nodeCount: 6, dropMemo: [4, 5], signerQuorum: ledgerQuorum(6), voteTimeout: 200 });
        assertLanded(report, 6);
    });

    test('a pre-filled election of N votes lands 0', () => {
        const chosen = [C0, C1, C2];
        const report = runCluster({
            nodeCount: 3,
            prefillContributions: chosen,
            alignedDelivery: true,
            voteTimeout: 200
        });
        assertAborted(report, /acquire vote rejected: double vote/);
        const forbidden = derivePublicKey(report.publicKeys, chosen);
        const landedPub = report.rounds[0] && report.rounds[0].memo && report.rounds[0].memo.pub;
        assert.ok(
            report.landed === 0 || landedPub !== forbidden,
            `pre-filled contributions must not select the key, landed ${report.landed} pub ${landedPub}`
        );
    });

    test('N chosen contributions cannot select the acquire key', () => {
        const chosen = [C0, C1, C2, C3, C4];
        const report = runCluster({
            nodeCount: 5,
            prefillContributions: chosen,
            alignedDelivery: true,
            signerQuorum: ledgerQuorum(5),
            voteTimeout: 200
        });
        const forbidden = derivePublicKey(report.publicKeys, chosen);
        const landedPub = report.rounds[0] && report.rounds[0].memo && report.rounds[0].memo.pub;
        assert.equal(report.attempts, 0, `chosen contributions must not be submitted, got ${report.attempts} attempts`);
        assert.ok(
            report.landed === 0 || landedPub !== forbidden,
            `N chosen contributions must not select the key, landed ${report.landed} pub ${landedPub} forbidden ${forbidden}`
        );
    });

    test('changing any one contribution changes the memo IV and ephemeral pubkey', () => {
        const baseline = [C0, C1, C2];
        const first = runCluster({ nodeCount: 3, fixedContributions: baseline, voteTimeout: 200 });
        assertLanded(first, 3);
        for (let index = 0; index < baseline.length; index++) {
            const changed = baseline.slice();
            // Stay clear of a new minimum or maximum when the changed node is in the middle,
            // so a min-only or max-only derivation cannot hide the change.
            const replacement = index === 0 ? '10' : index === baseline.length - 1 ? '34' : '12';
            changed[index] = replacement.repeat(32);
            const next = runCluster({ nodeCount: 3, fixedContributions: changed, voteTimeout: 200 });
            assertLanded(next, 3);
            assert.notEqual(first.rounds[0].memo.iv, next.rounds[0].memo.iv, `changing contribution ${index} must change the memo IV`);
            assert.notEqual(first.rounds[0].memo.pub, next.rounds[0].memo.pub, `changing contribution ${index} must change the ephemeral pubkey`);
        }
    });

    test('fixed contributions produce the documented IV and ephemeral pubkey', () => {
        const contributions = [C0, C1, C2];
        const report = runCluster({ nodeCount: 3, fixedContributions: contributions, voteTimeout: 200 });
        assertLanded(report, 3);
        const expected = deriveMaterial(report.publicKeys, contributions);
        assert.equal(report.rounds[0].memo.iv, expected.iv.toString('hex'), 'memo IV must match SHA-256 of the IV domain and the sorted contributions');
        assert.equal(report.rounds[0].memo.pub, expected.pub.toString('hex'), 'memo ephemeral pubkey must match the key domain hash');
    });

    test('a non-UNL sender is ignored and the honest memo is unchanged', () => {
        const contributions = [C0, C1, C2];
        const outsider = 'ab'.repeat(32);
        const report = runCluster({
            nodeCount: 3,
            fixedContributions: contributions,
            nonUnlContribution: outsider,
            nonUnlKey: 'ff'.repeat(32),
            voteTimeout: 200
        });
        assertLanded(report, 3);
        const expected = deriveMaterial(report.publicKeys, contributions);
        assert.equal(report.rounds[0].memo.iv, expected.iv.toString('hex'), 'a non-UNL contribution must not change the memo IV');
        assert.equal(report.rounds[0].memo.pub, expected.pub.toString('hex'), 'a non-UNL contribution must not change the ephemeral pubkey');
        const observed = `${report.stdio.out}\n${report.stdio.err}`;
        assert.match(observed, /acquire vote ignored from non-unl sender f{64}/, 'a non-UNL sender must be recorded');
    });

    test('a malformed contribution does not land', () => {
        const report = runCluster({
            nodeCount: 3,
            fixedContributions: [C0, C1, C2],
            malformedIndex: 1,
            voteTimeout: 200
        });
        assertAborted(report, /acquire key contribution must be 32 bytes/);
    });

    test('memo votes that disagree on the contributor set do not land', () => {
        const report = runCluster({ nodeCount: 3, tamperMemoSets: true, voteTimeout: 200 });
        assertAborted(report, /acquire memo agreement below threshold/);
    });

    test('cipher buffers and contribution parts are wiped after submit', () => {
        const report = runCluster({ nodeCount: 3, voteTimeout: 200 });
        assertLanded(report, 3);
        assert.equal(report.cipherWiped, true, 'acquire buffers passed to the cipher must be wiped after submit');
        for (const [contribution, count] of Object.entries(report.wipeCounts)) {
            assert.ok(count >= 3, `each contribution buffer must be wiped on every node, ${contribution} wiped ${count} times`);
        }
    });

    test('secrets do not appear in errors or return values', () => {
        const success = runCluster({ nodeCount: 3, voteTimeout: 200 });
        assertLanded(success, 3);
        assertNoSecrets(success, 'success');

        const mismatch = runCluster({ nodeCount: 3, swapNode: 0, voteTimeout: 200 });
        assert.equal(mismatch.attempts, 0, 'mismatch must not submit');
        assertNoSecrets(mismatch, 'mismatch');

        const below = runCluster({ nodeCount: 3, offline: [1, 2], signerQuorum: ledgerQuorum(3), voteTimeout: 200 });
        assertAborted(below, /acquire key agreement below threshold/);
        assertNoSecrets(below, 'below threshold');

        const doubled = runCluster({ nodeCount: 3, doubleVote: { phase: 'contribution', index: 0 }, voteTimeout: 200 });
        assertAborted(doubled, /acquire vote rejected: double vote/);
        assertNoSecrets(doubled, 'double vote');
    });
});

function ledgerQuorum(nodeCount) {
    // test/contract/src/contract.js:44 with signerWeight 1. XrplContext.loadSignerList
    // copies the resulting SignerQuorum (src/context/XrplContext.ts:210).
    return Math.floor(nodeCount * 0.6);
}

function runCluster(config) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acquire-live-'));
    const workDir = path.join(root, 'work');
    fs.mkdirSync(workDir);
    const resultPath = path.join(root, 'cluster-result.json');
    const child = spawnSync(process.execPath, [RUNNER, JSON.stringify({
        lclHash: FIXED_LCL_HASH,
        rounds: 1,
        resultPath,
        ...config
    })], {
        cwd: workDir,
        encoding: 'utf8',
        timeout: 20000
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
    return report;
}

function assertLanded(report, onlineCount) {
    assert.equal(
        report.landed,
        1,
        `exactly 1 acquire transaction must land, got ${report.landed} (${(report.errors || []).slice(0, 2).join(' | ')})`
    );
    const hashes = (report.rounds[0] ? report.rounds[0].hashes : []).filter(hash => hash);
    assert.equal(hashes.length, onlineCount, `every online node must return a hash, got ${(report.rounds[0] ? report.rounds[0].hashes : []).join(',')}`);
    assert.ok(hashes.every(hash => hash === hashes[0]), `online nodes must return the same hash, got ${hashes.join(',')}`);
    assert.equal(hashes[0], report.hashes[0], 'returned hash must be the transaction the ledger recorded');
}

function assertAborted(report, errorPattern) {
    assert.equal(report.attempts, 0, `acquire must not reach the ledger, got ${report.attempts} submissions (${(report.errors || []).slice(0, 2).join(' | ')})`);
    assert.equal(report.landed, 0, `acquire must not land, got ${report.landed}`);
    assert.match((report.errors || []).join('\n'), errorPattern, `abort error must match ${errorPattern}`);
}

function assertNoSecrets(report, label) {
    const haystack = [
        report.stdio && report.stdio.out,
        report.stdio && report.stdio.err,
        report.persisted,
        ...(report.errors || []),
        ...(report.returns || [])
    ].join('\n');
    for (const contribution of report.contributions || [])
        assert.equal(forms(contribution).some(form => haystack.includes(form)), false, `${label}: contribution must not appear in output, errors, or return values`);
    for (const hex of report.snapshots || []) {
        if (hex.length !== 32 && hex.length !== 64)
            continue;
        if (!forms(hex).some(form => haystack.includes(form)))
            continue;
        if (hex.length === 64)
            assert.fail(`${label}: acquire ephemeral key must not appear in output, errors, or return values`);
        assert.fail(`${label}: acquire IV must not appear in output, errors, or return values`);
    }
}

function forms(hex) {
    const buffer = Buffer.from(hex, 'hex');
    return [hex, hex.toUpperCase(), buffer.toString('base64'), JSON.stringify(Array.from(buffer))];
}

function deriveMaterial(publicKeys, contributions) {
    const ordered = publicKeys.map((publicKey, index) => ({ publicKey, contribution: contributions[index] }))
        .sort((left, right) => left.publicKey < right.publicKey ? -1 : left.publicKey > right.publicKey ? 1 : 0);
    const joined = Buffer.concat(ordered.map(item => Buffer.from(item.contribution, 'hex')));
    const iv = crypto.createHash('sha256').update(IV_DOMAIN).update(joined).digest().subarray(0, 16);
    let key = crypto.createHash('sha256').update(KEY_DOMAIN).update(joined).digest();
    for (let attempt = 1; attempt <= 8 && !isScalar(key); attempt++)
        key = crypto.createHash('sha256').update(KEY_DOMAIN).update(joined).update(Buffer.from([attempt])).digest();
    return { iv: Buffer.from(iv), key: Buffer.from(key), pub: uncompressedPublicKey(key) };
}

function derivePublicKey(publicKeys, contributions) {
    return deriveMaterial(publicKeys, contributions).pub.toString('hex');
}

function isScalar(key) {
    return key.length === 32 && key.compare(Buffer.alloc(32)) > 0 && key.compare(SECP256K1_ORDER) < 0;
}

function uncompressedPublicKey(privateKey) {
    if (!isScalar(privateKey))
        return null;
    return Buffer.from(ec.keyFromPrivate(privateKey).getPublic(false, 'array'));
}
