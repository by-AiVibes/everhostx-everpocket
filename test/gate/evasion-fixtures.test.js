'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { scanText } = require('./lib/src-scan');
const { derivedHitsInSource, KNOWN_TEXT } = require('./lib/taint');
const { SRC } = require('./lib/env');

function hygiene(text, rel = 'helpers/logger.ts') {
    const hits = scanText(path.join(SRC, rel), text);
    return [...hits.globalThis, ...hits.math, ...hits.date, ...hits.env];
}

function derived(text, rel = 'context/EvernodeContext.ts') {
    return derivedHitsInSource(text, path.join(SRC, rel));
}

function caught(id, hits) {
    assert.ok(hits.length > 0, `${id} was not reported`);
    assert.match(hits[0], /:\d+:/, `${id} hit does not name file:line (${hits[0]})`);
}

const HYGIENE = [
    ['global cast', '(global as any).__evpHook = { log };'],
    ['function this', "Function('return this')().__x = 1;"],
    ['destructured random', 'const {random}=Math; random();'],
    ['math alias', 'const M=Math; M.random();'],
    ['math cast', '(Math as any).random();'],
    ['date getTime', 'new Date().getTime();'],
    ['unary date', '+new Date();'],
    ['date alias', 'const D=Date; D.now();'],
    ['destructured now', 'const {now}=Date; now();'],
    ['performance.now', 'performance.now();'],
    ['hrtime bigint', 'process.hrtime.bigint();'],
    ['import env', "import { env } from 'process'; void env;"],
    ['process alias', 'const p=process; p.env.X;'],
    ['process cast', '(process as any).env.X;'],
    ['optional env', 'process?.env.X;'],
    ['template env', 'process[`env`];'],
    ['element env', "process['env'];"],
    ['assign destructure env', '({ env } = process);'],
    ['reflect env', "Reflect.get(process,'env');"],
    ['require process', "require('process').env;"],
    ['const destructure env', 'const { env } = process;'],
];

for (const [id, text] of HYGIENE) {
    test(`evasion fixture: ${id}`, () => {
        caught(id, hygiene(text));
    });
}

const DERIVED = [
    ['assigned lclHash', 'let m;\nm = this.hpContext.lclHash;\nconst iv = Buffer.from(m, "hex");'],
    ['renamed lclHash', 'const { lclHash: h } = this.hpContext;\nconst iv = Buffer.from(h, "hex");'],
    ['destructured lclHash', 'const { lclHash } = this.hpContext;\nconst iv = Buffer.from(lclHash, "hex");'],
    ['element lclHash', 'const iv = Buffer.from(this.hpContext[`lclHash`], "hex");'],
    ['helper returns lclHash', 'function material(){ return this.hpContext.lclHash; }\nconst iv = Buffer.from(material(), "hex");'],
    ['cipher key from lclHash', 'const lclHash = this.hpContext.lclHash;\nconst key = Buffer.from(lclHash);\ncreateCipheriv(alg, key, key.slice(0, 16));'],
    ['generateSeed entropy shorthand', 'const entropy = this.hpContext.publicKey;\nkp.generateSeed({ entropy });'],
    ['timestamp seed', 'const seed = Buffer.from(String(this.hpContext.timestamp));'],
];

for (const [id, text] of DERIVED) {
    test(`derived fixture: ${id}`, () => {
        caught(id, derived(text));
    });
}

test('logger toISOString and literal process.env stay quiet', () => {
    const dateHits = hygiene('function getDate(): string { return new Date().toISOString(); }');
    assert.deepEqual(dateHits, [], dateHits.join('\n'));
    const envHits = hygiene('const mode = process.env.NODE_ENV;');
    assert.deepEqual(envHits, [], envHits.join('\n'));
});

test('known acquire seed line and its binding stay quiet', () => {
    const text = `${'\n'.repeat(358)}${KNOWN_TEXT}\nconst prepared = { iv: seed.slice(0, 16), ephemPrivateKey: seed.slice(0, 32) };\n`;
    const hits = derived(text);
    assert.deepEqual(hits, [], hits.join('\n'));
});

test('protocol replay nonce is not a secret sink', () => {
    const hits = derived('const payload = { nonce: hpContext.lclSeqNo };', 'observation/ObservationSidecar.ts');
    assert.deepEqual(hits, [], hits.join('\n'));
});

test('a new iv binding beside the known seed is reported', () => {
    const text = `${'\n'.repeat(358)}${KNOWN_TEXT}\nconst ivBytes = Buffer.from(this.hpContext.lclHash,"hex").slice(0,16);\n`;
    const hits = derived(text);
    assert.ok(hits.some((hit) => hit.includes('ivBytes')), hits.join('\n'));
});
