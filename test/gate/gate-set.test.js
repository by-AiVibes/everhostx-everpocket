'use strict';
// test:gate's glob does not recurse. A test file outside that glob must fail here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const GATE = path.join(REPO, 'test', 'gate');

function walk(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        return entry.isDirectory() ? walk(full) : [full];
    });
}

function globToRegExp(glob) {
    let body = '';
    for (const ch of glob) {
        if (ch === '*')
            body += '[^/]*';
        else if ('\\^$+?.()|{}[]'.includes(ch))
            body += `\\${ch}`;
        else
            body += ch;
    }
    return new RegExp(`^${body}$`);
}

test('every test/gate test file is in the test:gate set', () => {
    const script = require(path.join(REPO, 'package.json')).scripts['test:gate'];
    const globs = script.split(/\s+/).filter((part) => part.includes('test/gate'));
    assert.ok(globs.length > 0, `package.json: test:gate script has no test/gate path (${script})`);
    const patterns = globs.map(globToRegExp);
    const missing = [];
    for (const file of walk(GATE)) {
        if (!file.endsWith('.test.js'))
            continue;
        const rel = path.relative(REPO, file).split(path.sep).join('/');
        if (!patterns.some((pattern) => pattern.test(rel)))
            missing.push(`${rel}:1: gate file not in test:gate set`);
    }
    assert.deepEqual(missing, [], missing.join('\n'));
});
