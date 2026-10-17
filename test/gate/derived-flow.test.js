'use strict';
// Secret material must not be reachable from lclHash, publicKey, lclSeqNo,
// or a hash, including through a renamed binding. The known one-line acquire
// seed is left to static.test.js so this check stays quiet on that line.
const test = require('node:test');
const assert = require('node:assert/strict');
const { derivedSecretHits } = require('./lib/taint');

test('no indirect or renamed derived secrets', () => {
    const hits = derivedSecretHits();
    assert.deepEqual(hits, [], `derived secret flow:\n${hits.join('\n')}`);
});
