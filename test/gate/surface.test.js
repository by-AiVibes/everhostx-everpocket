'use strict';
// Every value export and every public member is either on the frozen public
// surface or is called from src. Test-only names are rejected either way.
const test = require('node:test');
const assert = require('node:assert/strict');
const { deadExports, deadMembers } = require('./lib/surface');

test('every src export has a src caller or is on the public API allowlist', () => {
    const hits = deadExports();
    assert.deepEqual(hits, [], `dead export:\n${hits.join('\n')}`);
});

test('no test-only setter and no public member without a src caller', () => {
    const hits = deadMembers();
    assert.deepEqual(hits, [], `test-only or uncalled public member:\n${hits.join('\n')}`);
});
