'use strict';
// Source invariants enforced by grep over the src tree under test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { SRC } = require('./lib/env');
function files(d) { return fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(path.join(d, e.name)) : /\.ts$/.test(e.name) ? [path.join(d, e.name)] : []); }
function hits(re, filter = () => true) {
    const out = [];
    for (const f of files(SRC).filter(filter)) fs.readFileSync(f, 'utf8').split('\n').forEach((l, i) => { if (re.test(l) && !/^\s*(\/\/|\*)/.test(l)) out.push(`${path.relative(SRC, f)}:${i + 1}: ${l.trim()}`); });
    return out;
}
// Pre-existing upstream (origin/main 06ba9f5) lines outside the queue path, listed in docs/acceptance.md "Known upstream debt".
// Derived secrets are never allowlisted.
const BASELINE = new Set(['context/ClusterContext.ts: const DUMMY_OWNER_PUBKEY = "dummy_owner_pubkey";', 'context/VoteContext.ts: return votes ?? [];']);
const allowed = h => BASELINE.has(h.replace(/:\d+:/, ':'));
const none = (h, what) => { h = h.filter(x => !allowed(x)); assert.deepEqual(h, [], `${what}:\n${h.join('\n')}`); };
test('src tree present', () => assert.ok(fs.existsSync(SRC) && files(SRC).length > 0));
test('no test-only src branches (process.env / VITEST / NODE_ENV / EVP_ / GATE_)', () => none(hits(/process\.env|VITEST|NODE_ENV|\bEVP_|\bGATE_/), 'test-only branch'));
test('no fakes in src', () => { none(files(SRC).filter(f => /fake|mock|stub/i.test(path.basename(f))).map(f => path.relative(SRC, f)), 'fake file in src'); none(hits(/class\s+\w*(Fake|Mock|Stub)\w*/), 'fake class in src'); });
test('no placeholders', () => none(hits(/placeholder|['"`]local_|['"`]TODO|['"`]PLACEHOLDER|['"`]dummy/i), 'placeholder'));
test('no ?? literal/DEFAULT defaults', () => none(hits(/\?\?\s*(['"`\d\[{]|-\d|true\b|false\b|DEFAULT_)/), '?? default'));
test('no Math.random / Date.now in queue, observation or deterministic paths', () =>
    none(hits(/Math\.random|Date\.now/, f => /cluster|observation|ClusterContext/.test(f)), 'non-deterministic source'));
test('no derived secrets (keys/seeds/IVs/nonces from hashes or public data)', () => {
    none(hits(/deriveMessageKeypair|deriveReplacementSignerKeypair|fromEntropy|entropy\s*:/), 'derived keypair');
    none(hits(/deriveKeypair\s*\(\s*(?!seed\b|nodeSecret\b)/), 'deriveKeypair on non-random input');
    none(hits(/(iv|seed|nonce|secret|privateKey)\w*\s*[:=].*(lclHash|createHash|sha256|sha512|opRef)/i), 'secret from hash/public data');
});
