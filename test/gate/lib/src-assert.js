'use strict';
// Every scanner refuses an empty or partial src tree with an assertion.
// A missing directory must not surface as a TypeError from readdir or the checker.
const assert = require('node:assert/strict');
const fs = require('fs');
const { SRC } = require('./env');
const { walkTs, relSrc } = require('./src-walk');

const MIN_TS_FILES = 10;
const REQUIRED = [
    'index.ts',
    'context/EvernodeContext.ts',
    'context/ClusterContext.ts',
    'helpers/logger.ts',
];

function assertSrcTree() {
    if (!fs.existsSync(SRC))
        assert.fail(`src tree missing: ${SRC}`);
    let files;
    try {
        files = walkTs();
    }
    catch (error) {
        assert.fail(`src tree unreadable: ${SRC}: ${error.message}`);
    }
    assert.ok(
        Array.isArray(files) && files.length >= MIN_TS_FILES,
        `src tree too small: ${(files && files.length) || 0} .ts files under ${SRC}`
    );
    const rels = new Set(files.map((file) => relSrc(file)));
    for (const rel of REQUIRED)
        assert.ok(rels.has(rel), `src tree missing ${rel}`);
    return files;
}

module.exports = { assertSrcTree, MIN_TS_FILES, REQUIRED };
