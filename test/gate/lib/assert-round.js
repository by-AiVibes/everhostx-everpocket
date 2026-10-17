'use strict';
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const { SRC } = require('./env');
const { repoLine, srcLineContaining } = require('./sites');

const ROUND_ENTRY = 'test/gate/lib/sim/node.js';

function earlyRoundThrow() {
    const rel = 'context/ClusterContext.ts';
    const file = path.join(SRC, rel);
    if (!fs.existsSync(file))
        return null;
    const text = fs.readFileSync(file, 'utf8');
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    let site = null;
    function visit(node) {
        if (site)
            return;
        const isInit = ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name) && node.name.text === 'init';
        if ((ts.isConstructorDeclaration(node) || isInit) && node.body && node.body.statements.length > 0) {
            const first = node.body.statements[0];
            if (ts.isThrowStatement(first)) {
                const { line } = source.getLineAndCharacterOfPosition(first.getStart(source));
                site = `${rel}:${line + 1}`;
            }
        }
        ts.forEachChild(node, visit);
    }
    visit(source);
    return site;
}

function abortSite(out) {
    const err = (out.errs && out.errs[0]) || '';
    const quoted = err.replace(/^Error:\s*/, '').trim();
    if (quoted && quoted !== 'exit') {
        const found = srcLineContaining(quoted.slice(0, 80));
        if (found)
            return found;
    }
    const early = earlyRoundThrow();
    if (early)
        return early;
    return repoLine(ROUND_ENTRY, 'processConsensusUserInputs');
}

function assertNoAborts(out) {
    const errs = (out.errs || []).slice(0, 2).join(' | ');
    assert.equal(
        out.aborts,
        0,
        `${out.name}: aborts == 0 required, got ${out.aborts} at ${abortSite(out)}: ${errs}`
    );
}

module.exports = { assertNoAborts, abortSite };
