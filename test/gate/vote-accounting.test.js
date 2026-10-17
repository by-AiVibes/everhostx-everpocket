'use strict';
// VoteContext.vote is wrapped in the sim node and recorded before it returns.
// A crash that exits inside the round still has to show votesUsed == 0 when
// no vote ran, and election a2-15 stays at 0 unless src casts it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { SRC } = require('./lib/env');
const { repoLine } = require('./lib/sites');
const { runVoteSim } = require('./lib/vote-sim-run');

function voteSite() {
    const rel = 'context/ClusterContext.ts';
    const file = path.join(SRC, rel);
    if (fs.existsSync(file)) {
        const lines = fs.readFileSync(file, 'utf8').split('\n');
        const index = lines.findIndex((line) => line.includes('processConsensusUserInputs'));
        if (index >= 0)
            return `${rel}:${index + 1}`;
    }
    return repoLine('test/gate/lib/vote-sim-node.js', "k: 'vote'");
}

test('crash before any vote reports votesUsed == 0', async () => {
    const out = await runVoteSim({ rounds: 1, modes: () => 'abrupt' });
    const site = voteSite();
    assert.equal(out.votes, 0, `${site}: votesUsed == 0 on crash before vote, got ${out.votes}`);
});

test('sim nodes do not cast election a2-15', async () => {
    const out = await runVoteSim({ rounds: 2, modes: () => 'ok' });
    const site = voteSite();
    assert.equal(out.a215, 0, `${site}: votesUsed for election a2-15 == 0, got ${out.a215}`);
});
