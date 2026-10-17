'use strict';
// A node that calls VoteContext.vote and then crashes must still report the
// vote. lib/sim/node.js only attaches voteUsed to the clean-exit process.send.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fork } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DIST } = require('./lib/env');
const { repoLine } = require('./lib/sites');

const CHILD = path.join(__dirname, 'lib', 'vote-crash-node.js');
const CHILD_TIMEOUT_MS = 10000;

function waitForExit(child) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error('vote-crash child timed out'));
        }, CHILD_TIMEOUT_MS);
        child.once('exit', (code) => {
            clearTimeout(timer);
            resolve(code);
        });
    });
}

test('vote then crash is reported through emit before exit', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-vote-'));
    const opsFile = path.join(dir, 'ops.json');
    fs.writeFileSync(opsFile, '');
    const site = repoLine('test/gate/lib/sim/node.js', 'aborted,voteUsed');
    const child = fork(CHILD, [opsFile], { env: { ...process.env, DIST } });
    let code = null;
    let crash = null;
    try {
        code = await waitForExit(child);
    }
    catch (error) {
        crash = error;
    }
    const votes = fs.readFileSync(opsFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((row) => row.k === 'vote')
        .length;
    fs.rmSync(dir, { recursive: true, force: true });
    assert.equal(crash, null, `${site}: votesUsed not reported through emit() before crash: ${crash}`);
    assert.equal(votes, 1, `${site}: votesUsed not reported through emit() before crash (vc.vote then exit), got ${votes}`);
    assert.notEqual(code, 0, `${site}: vote-then-crash child exited cleanly (${code})`);
});
