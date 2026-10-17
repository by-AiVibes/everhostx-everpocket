'use strict';
// Dataflow check for key, IV, seed, and entropy material drawn from public
// or consensus data. Protocol replay nonces are not sinks.
// The known acquire line is carved out by exact file, line, and text:
//   context/EvernodeContext.ts:359
//   const seed = Buffer.from(this.hpContext.lclHash, "hex");
const ts = require('typescript');
const fs = require('fs');
const path = require('path');
const { walkTs, relSrc } = require('./src-walk');
const { SOURCE_PROPS } = require('./src-scan');
const { assertSrcTree } = require('./src-assert');

const SINK_NAME = /^(iv|seed|privateKey|ephemPrivateKey|entropy)([A-Z0-9_].*)?$/i;
const KNOWN_FILE = `context${path.sep}EvernodeContext.ts`;
const KNOWN_LINE = 359;
const KNOWN_TEXT = 'const seed = Buffer.from(this.hpContext.lclHash, "hex");';

function isSinkName(name) {
    return !!name && SINK_NAME.test(name);
}

function merge(left, right) {
    if (left === 'fresh' || right === 'fresh')
        return 'fresh';
    if (left === 'known' || right === 'known')
        return 'known';
    if (left === 'ctx' || right === 'ctx')
        return left === 'ctx' ? left : right;
    return null;
}

function fresh(value) {
    return value === 'fresh' ? 'fresh' : null;
}

function analyzeText(fileName, text) {
    const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const lines = text.split(/\r?\n/);
    const rel = fileName.includes('/') || fileName.includes('\\') ? relSrc(fileName) : fileName;
    const returns = new Map();

    function lineOf(node) {
        return source.getLineAndCharacterOfPosition(node.getStart(source)).line;
    }

    function lineText(node) {
        return lines[lineOf(node)] || '';
    }

    function isKnownSeed(node) {
        const normalized = fileName.split(path.sep).join('/');
        return normalized.endsWith('context/EvernodeContext.ts')
            && lineOf(node) + 1 === KNOWN_LINE
            && lineText(node).trim() === KNOWN_TEXT;
    }

    function reportOf(node) {
        const line = lineOf(node);
        return `${rel}:${line + 1}: ${(lines[line] || '').trim()}`;
    }

    function fnKey(node) {
        return `${fileName}:${node.pos}`;
    }

    function unwrap(node) {
        let current = node;
        while (current && (
            ts.isParenthesizedExpression(current)
            || ts.isAsExpression(current)
            || ts.isTypeAssertionExpression(current)
            || ts.isNonNullExpression(current)
            || ts.isSatisfiesExpression(current)
        ))
            current = current.expression;
        return current;
    }

    function propText(node) {
        if (!node)
            return '';
        if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isPrivateIdentifier(node) || ts.isNumericLiteral(node))
            return node.text;
        if (ts.isNoSubstitutionTemplateLiteral(node))
            return node.text;
        return '';
    }

    function lookup(scopes, name) {
        for (let i = scopes.length - 1; i >= 0; i--) {
            if (scopes[i].has(name))
                return scopes[i].get(name);
        }
        return null;
    }

    function calleeName(expr) {
        const value = unwrap(expr);
        if (!value)
            return '';
        if (ts.isIdentifier(value))
            return value.text;
        if (ts.isPropertyAccessExpression(value))
            return value.name.text;
        if (ts.isElementAccessExpression(value))
            return propText(unwrap(value.argumentExpression));
        return '';
    }

    function calledFnKey(expr) {
        const value = unwrap(expr);
        let nameNode = null;
        if (value && ts.isIdentifier(value))
            nameNode = value;
        else if (value && ts.isPropertyAccessExpression(value))
            nameNode = value.name;
        else if (value && ts.isElementAccessExpression(value) && value.argumentExpression)
            nameNode = unwrap(value.argumentExpression);
        if (!nameNode)
            return null;
        const symbol = source && nameNode;
        const decl = nearestFunction(nameNode);
        if (decl && ts.isIdentifier(nameNode) && decl.name && decl.name.text === nameNode.text && decl.parent === nameNode.parent)
            return fnKey(decl);
        return null;
    }

    function nearestFunction(node) {
        let current = node.parent;
        while (current) {
            if (ts.isFunctionLike(current))
                return current;
            current = current.parent;
        }
        return null;
    }

    function taintOf(expr, scopes) {
        if (!expr)
            return null;
        const value = unwrap(expr);
        if (!value)
            return null;
        if (ts.isIdentifier(value)) {
            const called = returns.get(calledFnKey(value) || '');
            const bound = lookup(scopes, value.text);
            return merge(bound, called);
        }
        if (ts.isPropertyAccessExpression(value)) {
            if (SOURCE_PROPS.has(value.name.text))
                return 'fresh';
            if (value.name.text === 'hpContext')
                return 'ctx';
            const viaCall = returns.get(fnKeyOfProperty(value) || '');
            return merge(viaCall, taintOf(value.expression, scopes));
        }
        if (ts.isElementAccessExpression(value)) {
            const index = value.argumentExpression && unwrap(value.argumentExpression);
            if (index && (ts.isStringLiteral(index) || ts.isNoSubstitutionTemplateLiteral(index)) && SOURCE_PROPS.has(index.text))
                return 'fresh';
            if (index && (ts.isStringLiteral(index) || ts.isNoSubstitutionTemplateLiteral(index)) && index.text === 'hpContext')
                return 'ctx';
            return merge(taintOf(value.expression, scopes), taintOf(value.argumentExpression, scopes));
        }
        if (ts.isCallExpression(value) || ts.isNewExpression(value)) {
            const name = calleeName(value.expression);
            let acc = returns.get(resolveCallKey(value, scopes) || '') || null;
            if (!acc && (name === 'createHash' || name === 'sha256' || name === 'sha512')) {
                for (const arg of value.arguments || []) {
                    if (taintOf(arg, scopes) === 'fresh')
                        acc = 'fresh';
                }
            }
            for (const arg of value.arguments || [])
                acc = merge(acc, taintOf(arg, scopes));
            if (taintOf(value.expression, scopes) === 'fresh')
                acc = 'fresh';
            const receiver = receiverOf(value.expression);
            if (receiver && (lookup(scopes, receiver) === 'fresh' || taintOf(unwrap(value.expression).expression, scopes) === 'fresh'))
                acc = merge(acc, 'fresh');
            return acc;
        }
        if (ts.isBinaryExpression(value))
            return merge(taintOf(value.left, scopes), taintOf(value.right, scopes));
        if (ts.isPrefixUnaryExpression(value) || ts.isPostfixUnaryExpression(value))
            return taintOf(value.operand, scopes);
        if (ts.isConditionalExpression(value))
            return merge(merge(taintOf(value.condition, scopes), taintOf(value.whenTrue, scopes)), taintOf(value.whenFalse, scopes));
        if (ts.isTemplateExpression(value)) {
            let acc = null;
            for (const span of value.templateSpans)
                acc = merge(acc, taintOf(span.expression, scopes));
            return acc;
        }
        if (ts.isArrayLiteralExpression(value)) {
            let acc = null;
            for (const element of value.elements)
                acc = merge(acc, taintOf(element, scopes));
            return acc;
        }
        if (ts.isObjectLiteralExpression(value)) {
            let acc = null;
            for (const prop of value.properties) {
                if (ts.isPropertyAssignment(prop))
                    acc = merge(acc, taintOf(prop.initializer, scopes));
                else if (ts.isShorthandPropertyAssignment(prop))
                    acc = merge(acc, lookup(scopes, prop.name.text));
            }
            return acc;
        }
        if (ts.isSpreadElement(value))
            return taintOf(value.expression, scopes);
        return null;
    }

    function receiverOf(expr) {
        const value = unwrap(expr);
        if (value && ts.isPropertyAccessExpression(value) && ts.isIdentifier(unwrap(value.expression)))
            return unwrap(value.expression).text;
        return '';
    }

    function fnKeyOfProperty(value) {
        return null;
    }

    function resolveCallKey(call, scopes) {
        const expr = unwrap(call.expression);
        if (!expr)
            return null;
        if (ts.isIdentifier(expr)) {
            const bound = lookup(scopes, `__fn__${expr.text}`);
            return bound || null;
        }
        if (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) {
            const name = ts.isPropertyAccessExpression(expr) ? expr.name.text : propText(unwrap(expr.argumentExpression));
            const bound = lookup(scopes, `__fn__${name}`);
            return bound || null;
        }
        return null;
    }

    function bindFunctionNames(scopes, node) {
        if (!node || !node.name || !ts.isIdentifier(node.name))
            return;
        scopes[scopes.length - 1].set(`__fn__${node.name.text}`, fnKey(node));
    }

    function collectReturns() {
        function walk(node, scopes) {
            if (ts.isFunctionLike(node)) {
                scopes.push(new Map());
                bindFunctionNames(scopes, node);
                if (node.body)
                    walk(node.body, scopes);
                scopes.pop();
                return;
            }
            if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isFunctionLike(node.initializer))
                scopes[scopes.length - 1].set(`__fn__${node.name.text}`, fnKey(node.initializer));
            ts.forEachChild(node, (child) => walk(child, scopes));
        }
        walk(source, [new Map()]);
    }

    function functionReturns(node, scopes) {
        let acc = null;
        function walk(current) {
            if (current !== node && ts.isFunctionLike(current))
                return;
            if (ts.isReturnStatement(current))
                acc = merge(acc, current.expression ? taintOf(current.expression, scopes) : null);
            ts.forEachChild(current, walk);
        }
        if (node.body)
            walk(node.body);
        return fresh(acc) || (acc === 'known' ? 'known' : null);
    }

    function iterateReturns() {
        collectReturns();
        const scopes = [new Map()];
        function indexFns(node) {
            if (ts.isFunctionLike(node) && node.name && ts.isIdentifier(node.name))
                scopes[scopes.length - 1].set(`__fn__${node.name.text}`, fnKey(node));
            if (ts.isFunctionLike(node)) {
                scopes.push(new Map(scopes[scopes.length - 1]));
                ts.forEachChild(node, indexFns);
                scopes.pop();
                return;
            }
            ts.forEachChild(node, indexFns);
        }
        indexFns(source);
        const rootScope = scopes[0];
        for (let pass = 0; pass < 8; pass++) {
            let changed = false;
            function walk(node, active) {
                if (ts.isFunctionLike(node)) {
                    const local = new Map(active);
                    if (node.name && ts.isIdentifier(node.name))
                        local.set(`__fn__${node.name.text}`, fnKey(node));
                    const value = functionReturns(node, [rootScope, local]);
                    const key = fnKey(node);
                    if (returns.get(key) !== value && value) {
                        returns.set(key, value);
                        changed = true;
                    }
                    return;
                }
                ts.forEachChild(node, (child) => walk(child, active));
            }
            walk(source, rootScope);
            if (!changed && pass > 0)
                break;
        }
    }

    function sinkCall(node, scopes, hits) {
        if (!ts.isCallExpression(node))
            return;
        const name = calleeName(node.expression);
        const args = node.arguments || [];
        const tainted = (arg) => taintOf(arg, scopes) === 'fresh';
        if (name === 'createCipheriv' && (tainted(args[1]) || tainted(args[2])))
            hits.push(reportOf(node));
        if (name === 'createHmac' && tainted(args[1]))
            hits.push(reportOf(node));
        if ((name === 'generateSeed' || name === 'deriveKeypair') && args.some(tainted))
            hits.push(reportOf(node));
    }

    function bindIdentifier(scopes, name, node, initializer) {
        if (isKnownSeed(node)) {
            scopes[scopes.length - 1].set(name, 'known');
            return;
        }
        const taint = initializer ? taintOf(initializer, scopes) : null;
        if (taint)
            scopes[scopes.length - 1].set(name, taint === 'fresh' ? 'fresh' : taint);
        if (taint === 'fresh' && isSinkName(name))
            return reportOf(node);
        return null;
    }

    function destructure(scopes, pattern, initializer, hits) {
        if (!ts.isObjectBindingPattern(pattern))
            return;
        const objectTaint = taintOf(initializer, scopes);
        for (const element of pattern.elements) {
            if (element.dotDotDotToken || !ts.isIdentifier(element.name))
                continue;
            const prop = element.propertyName ? propText(element.propertyName) : element.name.text;
            const local = element.name.text;
            let taint = null;
            if (objectTaint === 'fresh')
                taint = 'fresh';
            else if (objectTaint === 'ctx' && SOURCE_PROPS.has(prop))
                taint = 'fresh';
            else if (SOURCE_PROPS.has(prop) && objectTaint === 'fresh')
                taint = 'fresh';
            if (taint)
                scopes[scopes.length - 1].set(local, taint);
            if (taint === 'fresh' && isSinkName(local))
                hits.push(reportOf(element));
        }
    }

    iterateReturns();
    const hits = [];
    const scopes = [new Map()];

    function visit(node) {
        if (ts.isFunctionLike(node)) {
            if (node.name && ts.isIdentifier(node.name))
                scopes[scopes.length - 1].set(`__fn__${node.name.text}`, fnKey(node));
            scopes.push(new Map());
            if (node.body)
                ts.forEachChild(node.body, visit);
            scopes.pop();
            return;
        }
        if (ts.isVariableDeclaration(node)) {
            if (ts.isIdentifier(node.name)) {
                const reported = bindIdentifier(scopes, node.name.text, node, node.initializer);
                if (reported)
                    hits.push(reported);
                if (node.initializer && ts.isFunctionLike(node.initializer))
                    scopes[scopes.length - 1].set(`__fn__${node.name.text}`, fnKey(node.initializer));
            }
            else
                destructure(scopes, node.name, node.initializer, hits);
        }
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
            const taint = taintOf(node.right, scopes);
            if (taint)
                scopes[scopes.length - 1].set(node.left.text, taint);
            if (taint === 'fresh' && isSinkName(node.left.text))
                hits.push(reportOf(node));
        }
        if (ts.isPropertyAssignment(node)) {
            const name = propText(node.name);
            if (isSinkName(name) && taintOf(node.initializer, scopes) === 'fresh')
                hits.push(reportOf(node));
        }
        if (ts.isShorthandPropertyAssignment(node) && isSinkName(node.name.text) && lookup(scopes, node.name.text) === 'fresh')
            hits.push(reportOf(node));
        sinkCall(node, scopes, hits);
        ts.forEachChild(node, visit);
    }

    visit(source);
    return [...new Set(hits)];
}

function derivedHitsInSource(text, fileName) {
    return analyzeText(fileName, text);
}

function derivedSecretHits() {
    assertSrcTree();
    const hits = [];
    for (const file of walkTs()) {
        if (file.endsWith('.d.ts'))
            continue;
        hits.push(...analyzeText(file, fs.readFileSync(file, 'utf8')));
    }
    return [...new Set(hits)];
}

module.exports = { derivedSecretHits, derivedHitsInSource, KNOWN_FILE, KNOWN_LINE, KNOWN_TEXT };
