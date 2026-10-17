'use strict';
// Dataflow check for secret material drawn from public or consensus data.
// The single-line name regex in static.test.js already owns the known
// `const seed = Buffer.from(this.hpContext.lclHash, "hex")` assignment.
// This pass reports flows that regex cannot see: renamed bindings,
// a later use, publicKey, and lclSeqNo.
const ts = require('typescript');
const fs = require('fs');
const { walkTs, relSrc } = require('./src-walk');
const { SOURCE_PROPS } = require('./src-scan');

const LEGACY_LINE = /(iv|seed|nonce|secret|privateKey)\w*\s*[:=].*(lclHash|createHash|sha256|sha512|opRef)/i;
const SINK_NAME = /^(iv|seed|nonce|secret|privateKey|ephemPrivateKey)([A-Z0-9_].*)?$/i;

function isSinkName(name) {
    return SINK_NAME.test(name);
}

function merge(left, right) {
    if (left === 'fresh' || right === 'fresh')
        return 'fresh';
    if (left === 'legacy' || right === 'legacy')
        return 'legacy';
    return null;
}

function analyzeFile(file) {
    const text = fs.readFileSync(file, 'utf8');
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const lines = text.split('\n');
    const hits = [];
    const scopes = [new Map()];

    function lookup(name) {
        for (let i = scopes.length - 1; i >= 0; i--) {
            if (scopes[i].has(name))
                return scopes[i].get(name);
        }
        return null;
    }

    function lineOf(node) {
        return source.getLineAndCharacterOfPosition(node.getStart(source)).line;
    }

    function report(node) {
        const line = lineOf(node);
        hits.push(`${relSrc(file)}:${line + 1}: ${(lines[line] || '').trim()}`);
    }

    function taintOf(expr) {
        if (!expr)
            return null;
        if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isTypeAssertionExpression(expr) || ts.isNonNullExpression(expr))
            return taintOf(expr.expression);
        if (ts.isIdentifier(expr))
            return lookup(expr.text);
        if (ts.isPropertyAccessExpression(expr)) {
            if (SOURCE_PROPS.has(expr.name.text))
                return 'fresh';
            return taintOf(expr.expression);
        }
        if (ts.isElementAccessExpression(expr)) {
            const index = expr.argumentExpression;
            if (index && ts.isStringLiteral(index) && SOURCE_PROPS.has(index.text))
                return 'fresh';
            return merge(taintOf(expr.expression), taintOf(index));
        }
        if (ts.isCallExpression(expr) || ts.isNewExpression(expr)) {
            const callee = expr.expression.getText(source);
            let acc = /createHash|\bsha256\b|\bsha512\b/.test(callee) ? 'fresh' : taintOf(expr.expression);
            for (const arg of expr.arguments || [])
                acc = merge(acc, taintOf(arg));
            return acc;
        }
        if (ts.isBinaryExpression(expr))
            return merge(taintOf(expr.left), taintOf(expr.right));
        if (ts.isPrefixUnaryExpression(expr) || ts.isPostfixUnaryExpression(expr))
            return taintOf(expr.operand);
        if (ts.isConditionalExpression(expr))
            return merge(merge(taintOf(expr.condition), taintOf(expr.whenTrue)), taintOf(expr.whenFalse));
        if (ts.isTemplateExpression(expr)) {
            let acc = null;
            for (const span of expr.templateSpans)
                acc = merge(acc, taintOf(span.expression));
            return acc;
        }
        if (ts.isArrayLiteralExpression(expr)) {
            let acc = null;
            for (const element of expr.elements)
                acc = merge(acc, taintOf(element));
            return acc;
        }
        if (ts.isObjectLiteralExpression(expr)) {
            let acc = null;
            for (const prop of expr.properties) {
                if (ts.isPropertyAssignment(prop))
                    acc = merge(acc, taintOf(prop.initializer));
                else if (ts.isShorthandPropertyAssignment(prop))
                    acc = merge(acc, lookup(prop.name.text));
            }
            return acc;
        }
        if (ts.isSpreadElement(expr))
            return taintOf(expr.expression);
        return null;
    }

    function bind(name, node, initializer) {
        const taint = initializer ? taintOf(initializer) : null;
        const legacyLine = LEGACY_LINE.test(lines[lineOf(node)] || '');
        if (legacyLine)
            scopes[scopes.length - 1].set(name, 'legacy');
        else if (taint)
            scopes[scopes.length - 1].set(name, taint);
        if (!legacyLine && taint === 'fresh' && isSinkName(name))
            report(node);
    }

    function visit(node) {
        if (ts.isFunctionLike(node)) {
            scopes.push(new Map());
            ts.forEachChild(node, visit);
            scopes.pop();
            return;
        }
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name))
            bind(node.name.text, node, node.initializer);
        if (ts.isPropertyAssignment(node)) {
            const name = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : '';
            if (isSinkName(name) && taintOf(node.initializer) === 'fresh')
                report(node);
        }
        ts.forEachChild(node, visit);
    }

    visit(source);
    return hits;
}

function derivedSecretHits() {
    const hits = [];
    for (const file of walkTs())
        hits.push(...analyzeFile(file));
    return [...new Set(hits)];
}

module.exports = { derivedSecretHits };
