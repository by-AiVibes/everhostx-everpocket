'use strict';
const assert = require('node:assert/strict');
const { landedPerOp } = require('./sim/run');
function noDivergence(out) {
    assert.equal(out.divergentRounds, 0, `${out.name}: state diverged, first=${JSON.stringify(out.first)}`);
    assert.equal(out.votesUsed, 0, `${out.name}: votes used for tx inputs`);
}
function allCompleteLandedOnce(out) {
    assert.deepEqual(out.opsLeft, [], `${out.name}: ops never completed: ${out.opsLeft}`);
    const per = landedPerOp(out);
    for (const [ref, n] of Object.entries(per))
        assert.equal(n, 1, `${out.name}: op ${ref} landed ${n} txs (must be exactly 1); all=${JSON.stringify(per)}`);
}
function atMostOnce(out) {
    for (const [ref, n] of Object.entries(landedPerOp(out)))
        assert.ok(n <= 1, `${out.name}: op ${ref} landed ${n} txs`);
}
module.exports = { noDivergence, allCompleteLandedOnce, atMostOnce };
