'use strict';
// Tamper check: every file under test/gate must match the committed MANIFEST.sha256.
// Regenerate only with an approved change: node test/gate/lib/manifest.js --write
const test = require('node:test');
const assert = require('node:assert/strict');
const { compute, read } = require('./lib/manifest');
test('test/gate/** matches MANIFEST.sha256', () => assert.deepEqual(compute(), read()));
