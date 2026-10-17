'use strict';

const assert = require('node:assert/strict');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, test } = require('node:test');
const elliptic = require('elliptic');
const { derivePrivateKey } = require('ripple-keypairs/dist/secp256k1');

const FIXED_LCL_HASH = '1a20bec21ef8038f32eaed2f4d1907b9f0bdcc02e05d1ee09b199ac13db6518a';
const IV_DOMAIN = Buffer.from('everpocket-acquire-iv-v1');
const KEY_DOMAIN = Buffer.from('everpocket-acquire-ephemeral-v2');
const SECP256K1_ORDER = Buffer.from('fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141', 'hex');
const RUNNER = path.join(__dirname, '../fixtures/acquire-cluster-run.js');
const ec = new elliptic.ec('secp256k1');

const C0 = '11'.repeat(32);
const C1 = '22'.repeat(32);
const C2 = '33'.repeat(32);
const C3 = '44'.repeat(32);
const C4 = '55'.repeat(32);
const C5 = '66'.repeat(32);
const FOREIGN_UNL_KEY = 'ed' + 'ff'.repeat(32);

describe('acquire votes are per sender and live at ceil(2n/3)', { concurrency: 1 }, () => {
    test('1 of 3 nodes offline lands exactly one transaction with the same hash', () => {
        const report = runCluster({ nodeCount: 3, offline: [2], signerQuorum: ledgerQuorum(3), voteTimeout: 300 });
        assertLanded(report, 2);
    });

    test('1 of 5 nodes offline lands exactly one transaction with the same hash', () => {
        const report = runCluster({ nodeCount: 5, offline: [4], signerQuorum: ledgerQuorum(5), voteTimeout: 300 });
        assertLanded(report, 4);
    });

    test('2 of 5 nodes offline aborts before multisign', () => {
        const report = runCluster({ nodeCount: 5, offline: [3, 4], signerQuorum: ledgerQuorum(5), voteTimeout: 300 });
        assertAborted(report, /acquire key agreement below threshold/);
        assert.equal(beforeMultisign(report), true, 'below threshold must not report a signature failure');
    });

    test('2 of 3 nodes offline aborts before multisign', () => {
        const report = runCluster({ nodeCount: 3, offline: [1, 2], signerQuorum: ledgerQuorum(3), voteTimeout: 300 });
        assertAborted(report, /acquire key agreement below threshold/);
        assert.equal(beforeMultisign(report), true, 'below threshold must not report a signature failure');
    });

    test('2 of 6 nodes offline still lands one transaction', () => {
        const report = runCluster({ nodeCount: 6, offline: [4, 5], signerQuorum: ledgerQuorum(6), voteTimeout: 300 });
        assertLanded(report, 4);
    });

    test('a double contribution vote aborts with 0 attempts', () => {
        const report = runCluster({ nodeCount: 3, doubleVote: { phase: 'contribution', index: 0 }, voteTimeout: 300 });
        assertAborted(report, /acquire vote rejected: double vote/);
    });

    test('a double memo vote aborts with 0 attempts', () => {
        const report = runCluster({ nodeCount: 3, doubleVote: { phase: 'memo', index: 1 }, voteTimeout: 300 });
        assertAborted(report, /acquire vote rejected: double vote/);
    });

    test('a double vote with another node offline aborts with 0 attempts', () => {
        const report = runCluster({
            nodeCount: 3,
            offline: [2],
            doubleVote: { phase: 'contribution', index: 0 },
            signerQuorum: ledgerQuorum(3),
            voteTimeout: 300
        });
        assertAborted(report, /acquire vote rejected: double vote/);
    });

    test('one withheld memo vote on 3 nodes still lands one transaction', () => {
        const report = runCluster({ nodeCount: 3, dropMemo: [2], signerQuorum: ledgerQuorum(3), voteTimeout: 300 });
        assertLanded(report, 3);
    });

    test('two withheld memo votes on 3 nodes abort', () => {
        const report = runCluster({ nodeCount: 3, dropMemo: [1, 2], signerQuorum: ledgerQuorum(3), voteTimeout: 300 });
        assertAborted(report, /acquire memo agreement below threshold/);
    });

    test('two withheld memo votes on 5 nodes abort', () => {
        const report = runCluster({ nodeCount: 5, dropMemo: [3, 4], signerQuorum: ledgerQuorum(5), voteTimeout: 300 });
        assertAborted(report, /acquire memo agreement below threshold/);
    });

    test('two withheld memo votes on 6 nodes still land one transaction', () => {
        const report = runCluster({ nodeCount: 6, dropMemo: [4, 5], signerQuorum: ledgerQuorum(6), voteTimeout: 300 });
        assertLanded(report, 6);
    });

    test('a pre-filled election of N votes lands 0', () => {
        const chosen = [C0, C1, C2];
        const report = runCluster({
            nodeCount: 3,
            prefillContributions: chosen,
            alignedDelivery: true,
            voteTimeout: 300
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
            voteTimeout: 300
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
        const first = runCluster({ nodeCount: 3, fixedContributions: baseline, voteTimeout: 300 });
        assertLanded(first, 3);
        for (let index = 0; index < baseline.length; index++) {
            const changed = baseline.slice();
            const replacement = index === 0 ? '10' : index === baseline.length - 1 ? '34' : '12';
            changed[index] = replacement.repeat(32);
            const next = runCluster({ nodeCount: 3, fixedContributions: changed, voteTimeout: 300 });
            assertLanded(next, 3);
            assert.notEqual(first.rounds[0].memo.iv, next.rounds[0].memo.iv, `changing contribution ${index} must change the memo IV`);
            assert.notEqual(first.rounds[0].memo.pub, next.rounds[0].memo.pub, `changing contribution ${index} must change the ephemeral pubkey`);
        }
    });

    test('fixed contributions produce the R5 IV and ephemeral pubkey for n=3', () => {
        const contributions = [C0, C1, C2];
        const report = runCluster({ nodeCount: 3, fixedContributions: contributions, voteTimeout: 300 });
        assertLanded(report, 3);
        const expected = deriveMaterial(report.publicKeys, contributions);
        assert.equal(report.rounds[0].memo.iv, expected.iv.toString('hex'), 'memo IV must match the IV domain hash');
        assert.equal(report.rounds[0].memo.pub, expected.pub.toString('hex'), 'memo ephemeral pubkey must match derivePrivateKey');
        assert.equal(expected.key.equals(expected.libraryKey), true, 'node:crypto known answer must equal derivePrivateKey');
    });

    test('a non-UNL sender is ignored and the honest memo is unchanged', () => {
        const contributions = [C0, C1, C2];
        const report = runCluster({
            nodeCount: 3,
            fixedContributions: contributions,
            nonUnlContribution: 'ab'.repeat(32),
            nonUnlKey: FOREIGN_UNL_KEY,
            nonUnlAlsoUndefined: true,
            nonUnlUndefinedContribution: 'cd'.repeat(32),
            voteTimeout: 300
        });
        assertLanded(report, 3);
        const expected = deriveMaterial(report.publicKeys, contributions);
        assert.equal(report.rounds[0].memo.iv, expected.iv.toString('hex'), 'a non-UNL contribution must not change the memo IV');
        assert.equal(report.rounds[0].memo.pub, expected.pub.toString('hex'), 'a non-UNL contribution must not change the ephemeral pubkey');
        const observed = `${report.stdio.out}\n${report.stdio.err}`;
        assert.match(observed, new RegExp(`acquire vote ignored from non-unl sender ${FOREIGN_UNL_KEY}`), 'a foreign ed-key sender must be recorded');
        assert.match(observed, /acquire vote ignored from non-unl sender unknown/, 'an undefined sender must be recorded');
    });

    test('a malformed contribution does not land', () => {
        const report = runCluster({
            nodeCount: 3,
            fixedContributions: [C0, C1, C2],
            malformedIndex: 1,
            voteTimeout: 300
        });
        assertAborted(report, /acquire key contribution must be 32 bytes/);
    });

    test('memo votes that disagree on the contributor set do not land', () => {
        const report = runCluster({ nodeCount: 3, tamperMemoSets: true, voteTimeout: 300 });
        assertAborted(report, /acquire memo agreement below threshold/);
    });

    test('cipher buffers and contribution parts are wiped after submit', () => {
        const report = runCluster({ nodeCount: 3, voteTimeout: 300 });
        assertLanded(report, 3);
        assert.equal(report.cipherWiped, true, 'acquire buffers passed to the cipher must be wiped after submit');
        assert.equal(report.scratchZero, true, 'acquire scratch buffers must be zero after submit');
        assert.equal(report.partsZero, true, 'sorted contribution parts must be zero after submit');
        for (const [contribution, count] of Object.entries(report.wipeCounts)) {
            assert.ok(count >= 3, `each contribution buffer must be wiped on every node, ${contribution} wiped ${count} times`);
        }
    });

    test('secrets do not appear in errors or return values', () => {
        const success = runCluster({ nodeCount: 3, voteTimeout: 300 });
        assertLanded(success, 3);
        assertNoSecrets(success, 'success');

        const mismatch = runCluster({ nodeCount: 3, swapNode: 0, voteTimeout: 300 });
        assert.equal(mismatch.attempts, 0, 'mismatch must not submit');
        assertNoSecrets(mismatch, 'mismatch');

        const below = runCluster({ nodeCount: 3, offline: [1, 2], signerQuorum: ledgerQuorum(3), voteTimeout: 300 });
        assertAborted(below, /acquire key agreement below threshold/);
        assertNoSecrets(below, 'below threshold');

        const doubled = runCluster({ nodeCount: 3, doubleVote: { phase: 'contribution', index: 0 }, voteTimeout: 300 });
        assertAborted(doubled, /acquire vote rejected: double vote/);
        assertNoSecrets(doubled, 'double vote');

        const memoDouble = runCluster({ nodeCount: 3, doubleVote: { phase: 'memo', index: 1 }, voteTimeout: 300 });
        assertAborted(memoDouble, /acquire vote rejected: double vote/);
        assertNoSecrets(memoDouble, 'memo double vote');

        const malformed = runCluster({
            nodeCount: 3,
            fixedContributions: [C0, C1, C2],
            malformedIndex: 1,
            voteTimeout: 300
        });
        assertAborted(malformed, /acquire key contribution must be 32 bytes/);
        assertNoSecrets(malformed, 'malformed contribution');

        const memoSplit = runCluster({ nodeCount: 3, tamperMemoSets: true, voteTimeout: 300 });
        assertAborted(memoSplit, /acquire memo agreement below threshold/);
        assertNoSecrets(memoSplit, 'memo mismatch');

        const unavailable = runCluster({ nodeCount: 3, unlFault: 'empty', voteTimeout: 300 });
        assertAborted(unavailable, /acquire UNL unavailable/);
        assertNoSecrets(unavailable, 'UNL unavailable');

        const shortIv = runCluster({ nodeCount: 1, cipherLengthFault: 'iv8', voteTimeout: 300 });
        assertAborted(shortIv, /acquire IV must be 16 bytes/);
        assertNoSecrets(shortIv, 'short IV');
    });

    test('n=1 lands exactly one transaction through the vote path', () => {
        const report = runCluster({ nodeCount: 1, rounds: 2, voteTimeout: 300 });
        assert.equal(report.landed, 2, `two n=1 acquires must each land, got ${report.landed}`);
        assert.equal(report.attempts, 2, `two n=1 acquires must each be attempted, got ${report.attempts}`);
        const pubs = [];
        for (const round of report.rounds) {
            const hashes = round.hashes.filter(hash => hash);
            assert.equal(hashes.length, 1, 'the single node must return a hash');
            assert.ok(round.memo, 'n=1 acquire must submit a memo');
            assert.equal(round.contributions.length, 1, 'n=1 acquire must publish its contribution vote');
            const expected = deriveMaterial(report.publicKeys, round.contributions);
            assert.equal(round.memo.pub, expected.pub.toString('hex'), 'n=1 memo pubkey must be the known answer of that node contribution');
            assert.equal(round.memo.iv, expected.iv.toString('hex'), 'n=1 memo IV must be the known answer of that node contribution');
            pubs.push(round.memo.pub);
        }
        assert.notEqual(pubs[0], pubs[1], 'two n=1 acquires with the same lclHash must not reuse the ephemeral pubkey');
        assert.notEqual(report.rounds[0].memo.iv, report.rounds[1].memo.iv, 'two n=1 acquires with the same lclHash must not reuse the IV');
    });

    test('fixed n=1 contribution matches the R5 known answer', () => {
        const report = runCluster({ nodeCount: 1, fixedContributions: [C0], voteTimeout: 300 });
        assertLanded(report, 1);
        const expected = deriveMaterial(report.publicKeys, [C0]);
        assert.equal(report.rounds[0].memo.iv, expected.iv.toString('hex'), 'n=1 memo IV');
        assert.equal(report.rounds[0].memo.pub, expected.pub.toString('hex'), 'n=1 memo pubkey');
    });

    test('an empty UNL fails closed with 0 attempts', () => {
        const report = runCluster({ nodeCount: 3, unlFault: 'empty', voteTimeout: 300 });
        assertAborted(report, /acquire UNL unavailable/);
        assertNoContributionVote(report);
    });

    test('a throwing UNL fails closed with the thrown error and 0 attempts', () => {
        const report = runCluster({ nodeCount: 3, unlFault: 'throw', unlFaultMessage: 'contract unl failed', voteTimeout: 300 });
        assertAborted(report, /contract unl failed/);
        assertNoContributionVote(report);
    });

    test('a UNL without this node fails closed', () => {
        const report = runCluster({ nodeCount: 3, unlFault: 'missing-self', voteTimeout: 300 });
        assertAborted(report, /acquire UNL unavailable/);
        assertNoContributionVote(report);
    });

    test('a malformed UNL key fails closed', () => {
        const report = runCluster({ nodeCount: 3, unlFault: 'malformed', voteTimeout: 300 });
        assertAborted(report, /acquire UNL unavailable/);
        assertNoContributionVote(report);
    });

    test('a duplicate UNL entry fails closed', () => {
        const report = runCluster({ nodeCount: 3, unlFault: 'duplicate', voteTimeout: 300 });
        assertAborted(report, /acquire UNL unavailable/);
        assertNoContributionVote(report);
    });

    test('a missing UNL list fails closed with the thrown error', () => {
        const report = runCluster({ nodeCount: 3, unlFault: 'absent', voteTimeout: 300 });
        assert.equal(report.attempts, 0, `a missing UNL must not reach the ledger, got ${report.attempts}`);
        assert.equal(report.landed, 0, `a missing UNL must not land, got ${report.landed}`);
        assert.match((report.errors || []).join('\n'), /is not a function/, 'a missing list() must propagate');
        assertNoContributionVote(report);
    });

    test('an 8-byte IV at the cipher call site throws and does not land', () => {
        const report = runCluster({ nodeCount: 1, cipherLengthFault: 'iv8', voteTimeout: 300 });
        assertAborted(report, /acquire IV must be 16 bytes/);
    });

    test('a 33-byte key at the cipher call site throws and does not land', () => {
        const report = runCluster({ nodeCount: 1, cipherLengthFault: 'key33', voteTimeout: 300 });
        assertAborted(report, /acquire ephemeral key must be 32 bytes/);
    });

    test('a 31-byte key at the cipher call site throws and does not land', () => {
        const report = runCluster({ nodeCount: 1, cipherLengthFault: 'key31', voteTimeout: 300 });
        assertAborted(report, /acquire ephemeral key must be 32 bytes/);
    });

    test('P-honest n=3 and n=5 land one shared transaction', () => {
        const three = runCluster({ nodeCount: 3, voteTimeout: 300 });
        assertLanded(three, 3);
        assert.equal(three.keyLeaked, false);
        assert.equal(three.contributionLeaked, false);
        const five = runCluster({ nodeCount: 5, voteTimeout: 300 });
        assertLanded(five, 5);
        assert.equal(five.keyLeaked, false);
        assert.equal(five.contributionLeaked, false);
    });

    test('P-withhold one silent node still lands', () => {
        const three = runCluster({ nodeCount: 3, withhold: [2], signerQuorum: ledgerQuorum(3), voteTimeout: 300 });
        assertLanded(three, 3);
        const five = runCluster({ nodeCount: 5, withhold: [4], signerQuorum: ledgerQuorum(5), voteTimeout: 300 });
        assertLanded(five, 5);
    });

    test('P-wh2 two of three withholding aborts before multisign', () => {
        const report = runCluster({ nodeCount: 3, withhold: [1, 2], signerQuorum: ledgerQuorum(3), voteTimeout: 300 });
        assertAborted(report, /acquire key agreement below threshold/);
        assert.equal(beforeMultisign(report), true, 'withholding below threshold must abort before multisign');
    });

    test('P-equivocate different contributions from one sender abort', () => {
        const report = runCluster({
            nodeCount: 3,
            equivocate: { index: 0, values: [C0, C1, C2] },
            voteTimeout: 300
        });
        assertAborted(report, /acquire vote rejected: double vote/);
    });

    test('P-dup every acquire vote sent twice aborts', () => {
        const report = runCluster({ nodeCount: 3, duplicateAll: true, voteTimeout: 300 });
        assertAborted(report, /acquire vote rejected: double vote/);
    });

    test('P-dupall a duplicate vote plus an offline node aborts', () => {
        const report = runCluster({
            nodeCount: 3,
            offline: [2],
            duplicateAll: true,
            signerQuorum: ledgerQuorum(3),
            voteTimeout: 300
        });
        assertAborted(report, /acquire vote rejected: double vote/);
    });

    test('P-late votes replayed into the next round are not mixed', () => {
        const report = runCluster({ nodeCount: 3, rounds: 2, lateReplay: true, voteTimeout: 300 });
        assert.equal(report.rounds.length, 2, 'late replay runs two rounds');
        assert.equal(report.landed, 2, `each round must land, got ${report.landed}`);
        for (const round of report.rounds) {
            assert.ok(round.memo, 'each round must submit a memo');
            const expected = deriveMaterial(report.publicKeys, round.contributions);
            assert.equal(round.memo.pub, expected.pub.toString('hex'), 'a replayed vote must not change the round key');
            assert.equal(round.memo.iv, expected.iv.toString('hex'), 'a replayed vote must not change the round IV');
        }
        assert.notEqual(report.rounds[0].memo.pub, report.rounds[1].memo.pub, 'round 2 must not reuse round 1 key');
    });
});

function ledgerQuorum(nodeCount) {
    // test/contract/src/contract.js:44 with signerWeight 1. XrplContext.loadSignerList
    // copies the resulting SignerQuorum (src/context/XrplContext.ts:210).
    return Math.floor(nodeCount * 1 * 0.6);
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

function assertNoContributionVote(report) {
    assert.equal((report.contributions || []).length, 0, 'a closed UNL failure must not publish a contribution vote');
}

function assertAborted(report, errorPattern) {
    assert.equal(report.attempts, 0, `acquire must not reach the ledger, got ${report.attempts} submissions (${(report.errors || []).slice(0, 2).join(' | ')})`);
    assert.equal(report.landed, 0, `acquire must not land, got ${report.landed}`);
    assert.match((report.errors || []).join('\n'), errorPattern, `abort error must match ${errorPattern}`);
}

function beforeMultisign(report) {
    const text = (report.errors || []).join('\n');
    return !text.includes('No enough signatures');
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
        if (/^0+$/.test(hex))
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
    const parts = Buffer.concat(ordered.map(item => Buffer.from(item.contribution, 'hex')));
    const iv = Buffer.from(crypto.createHash('sha256').update(IV_DOMAIN).update(parts).digest().subarray(0, 16));
    const seed = Buffer.concat([KEY_DOMAIN, parts]);
    const key = knownScalar(seed);
    const libraryKey = derivePrivateKey(seed, { validator: true }).toArrayLike(Buffer, 'be', 32);
    return { iv, key, libraryKey: Buffer.from(libraryKey), pub: uncompressedPublicKey(key) };
}

function derivePublicKey(publicKeys, contributions) {
    return deriveMaterial(publicKeys, contributions).pub.toString('hex');
}

function knownScalar(seed) {
    const order = BigInt('0x' + SECP256K1_ORDER.toString('hex'));
    for (let counter = 0; counter <= 0xffffffff; counter++) {
        const suffix = Buffer.alloc(4);
        suffix.writeUInt32BE(counter);
        const hash = crypto.createHash('sha512').update(seed).update(suffix).digest();
        const key = hash.subarray(0, 32);
        const value = BigInt('0x' + Buffer.from(key).toString('hex'));
        if (value > 0n && value < order)
            return Buffer.from(key);
    }
    throw new Error('known answer found no scalar');
}

function uncompressedPublicKey(privateKey) {
    return Buffer.from(ec.keyFromPrivate(privateKey).getPublic(false, 'array'));
}
