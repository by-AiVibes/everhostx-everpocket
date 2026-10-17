'use strict';
// Source bans the locked static.test.js does not cover: globalThis, src-wide
// Math.random / Date.now, and process.env reached without the literal form.
const test = require('node:test');
const assert = require('node:assert/strict');
const scan = require('./lib/src-scan');

function none(hits, what) {
    assert.deepEqual(hits, [], `${what}:\n${hits.join('\n')}`);
}

test('no globalThis hook in src', () => {
    none(scan.globalThisHits(), 'globalThis hook');
});

test('no Math.random anywhere in src', () => {
    none(scan.mathRandomHits(), 'Math.random');
});

test('no Date.now anywhere in src', () => {
    none(scan.dateNowHits(), 'Date.now');
});

test('no process env access except the literal process.env form', () => {
    none(scan.envEvasionHits(), 'env access without process.env');
});
