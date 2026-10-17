'use strict';
// test:gate does not compile. A dist built from another commit must fail this
// check instead of letting the suite run against stale JavaScript.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DIST, SRC } = require('./lib/env');

const REPO = path.resolve(__dirname, '..', '..');
const TSC = path.join(REPO, 'node_modules', 'typescript', 'bin', 'tsc');

function jsFiles(root) {
    if (!fs.existsSync(root))
        return [];
    const out = [];
    function walk(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory())
                walk(full);
            else if (entry.name.endsWith('.js'))
                out.push(path.relative(root, full).split(path.sep).join('/'));
        }
    }
    walk(root);
    return out.sort();
}

function hashFile(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function srcSite(jsRel) {
    const tsRel = jsRel.replace(/\.js$/, '.ts');
    const file = path.join(SRC, tsRel);
    if (!fs.existsSync(file))
        return `dist/${jsRel}:1`;
    return `${tsRel}:1`;
}

test('dist javascript matches a fresh compile of src', { timeout: 120000 }, () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-dist-'));
    try {
        execFileSync(process.execPath, [
            TSC,
            '-p', 'tsconfig.json',
            '--outDir', tmp,
            '--declaration', 'false',
            '--pretty', 'false',
            '--incremental', 'false',
        ], { cwd: REPO, encoding: 'utf8' });
        const fresh = new Set(jsFiles(tmp));
        const built = new Set(jsFiles(DIST));
        const names = [...new Set([...fresh, ...built])].sort();
        const mismatches = [];
        for (const rel of names) {
            const freshFile = path.join(tmp, rel);
            const builtFile = path.join(DIST, rel);
            if (!fs.existsSync(builtFile)) {
                mismatches.push(`${srcSite(rel)}: dist/${rel} missing`);
                continue;
            }
            if (!fs.existsSync(freshFile)) {
                mismatches.push(`${srcSite(rel)}: dist/${rel} is not produced by current src`);
                continue;
            }
            const freshHash = hashFile(freshFile);
            const builtHash = hashFile(builtFile);
            if (freshHash !== builtHash)
                mismatches.push(`${srcSite(rel)}: dist/${rel} stale against src`);
        }
        assert.deepEqual(mismatches, [], `dist stale against src:\n${mismatches.join('\n')}`);
    }
    finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});
