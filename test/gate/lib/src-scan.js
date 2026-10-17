'use strict';
// Source bans the locked static.test.js does not cover.
// Literal `process.env` stays allowed. `new Date().toISOString()` stays quiet.
const ts = require('typescript');
const fs = require('fs');
const { walkTs, relSrc } = require('./src-walk');
const { assertSrcTree } = require('./src-assert');

const SOURCE_PROPS = new Set(['lclHash', 'publicKey', 'lclSeqNo', 'opRef', 'timestamp']);

function parse(fileName, text) {
    const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    return { text, source, lines: text.split(/\r?\n/) };
}

function at(fileName, source, lines, node) {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    const rel = fileName.includes('/') || fileName.includes('\\') ? relSrc(fileName) : fileName;
    return `${rel}:${line + 1}: ${(lines[line] || '').trim()}`;
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

function inTypePosition(node) {
    let current = node;
    while (current) {
        if (ts.isTypeNode(current) || ts.isTypeAliasDeclaration(current) || ts.isInterfaceDeclaration(current))
            return true;
        current = current.parent;
    }
    return false;
}

function isDeclarationName(node) {
    const parent = node.parent;
    if (!parent || !parent.name)
        return false;
    return parent.name === node;
}

function newScope(parent) {
    return {
        math: new Set(parent ? parent.math : ['Math']),
        date: new Set(parent ? parent.date : ['Date']),
        process: new Set(parent ? parent.process : ['process']),
        performance: new Set(parent ? parent.performance : ['performance']),
        randomFn: new Set(),
        dateNowFn: new Set(),
        parent,
    };
}

function aliasKind(scope, expr) {
    const value = unwrap(expr);
    if (!value || !ts.isIdentifier(value))
        return null;
    if (scope.math.has(value.text))
        return 'math';
    if (scope.date.has(value.text))
        return 'date';
    if (scope.process.has(value.text))
        return 'process';
    if (scope.performance.has(value.text))
        return 'performance';
    return null;
}

function isNewDate(scope, expr) {
    const value = unwrap(expr);
    return !!(value && ts.isNewExpression(value) && aliasKind(scope, value.expression) === 'date');
}

function propertyName(node) {
    if (!node)
        return '';
    if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node) || ts.isPrivateIdentifier(node))
        return node.text;
    if (ts.isNoSubstitutionTemplateLiteral(node))
        return node.text;
    return '';
}

function elementName(node) {
    if (!node || !node.argumentExpression)
        return '';
    const arg = unwrap(node.argumentExpression);
    if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))
        return arg.text;
    return '';
}

function scanText(fileName, text) {
    const { source, lines } = parse(fileName, text);
    const hits = { globalThis: [], math: [], date: [], env: [] };
    let scope = newScope(null);

    function hit(kind, node) {
        hits[kind].push(at(fileName, source, lines, node));
    }

    function bindPattern(name, initializer) {
        const kind = aliasKind(scope, initializer);
        if (ts.isIdentifier(name)) {
            if (kind === 'math')
                scope.math.add(name.text);
            else if (kind === 'date')
                scope.date.add(name.text);
            else if (kind === 'process')
                scope.process.add(name.text);
            else if (kind === 'performance')
                scope.performance.add(name.text);
            const access = memberAccess(initializer);
            if (access && access.object === 'math' && access.member === 'random')
                scope.randomFn.add(name.text);
            if (access && access.object === 'date' && access.member === 'now')
                scope.dateNowFn.add(name.text);
            return;
        }
        if (!ts.isObjectBindingPattern(name) && !ts.isArrayBindingPattern(name))
            return;
        if (!ts.isObjectBindingPattern(name))
            return;
        for (const element of name.elements) {
            if (element.dotDotDotToken || !ts.isIdentifier(element.name))
                continue;
            const prop = element.propertyName ? propertyName(element.propertyName) : element.name.text;
            const local = element.name.text;
            if (kind === 'math' && prop === 'random')
                scope.randomFn.add(local);
            if (kind === 'date' && prop === 'now')
                scope.dateNowFn.add(local);
            if (kind === 'process' && prop === 'env')
                hit('env', element);
        }
    }

    function memberAccess(expr) {
        const value = unwrap(expr);
        if (!value)
            return null;
        if (ts.isPropertyAccessExpression(value)) {
            const object = aliasKind(scope, value.expression);
            return { object, member: value.name.text, node: value, optional: !!value.questionDotToken };
        }
        if (ts.isElementAccessExpression(value)) {
            const object = aliasKind(scope, value.expression);
            return { object, member: elementName(value), node: value, optional: !!value.questionDotToken };
        }
        return null;
    }

    function literalProcessEnv(expr) {
        const value = unwrap(expr);
        return !!(value
            && ts.isPropertyAccessExpression(value)
            && !value.questionDotToken
            && ts.isIdentifier(value.expression)
            && value.expression.text === 'process'
            && value.name.text === 'env');
    }

    function noteAccess(expr) {
        const access = memberAccess(expr);
        if (!access || !access.object)
            return;
        if (access.object === 'math' && access.member === 'random')
            hit('math', access.node);
        if (access.object === 'date' && access.member === 'now')
            hit('date', access.node);
        if (access.object === 'performance' && access.member === 'now')
            hit('date', access.node);
        if (access.object === 'process' && access.member === 'hrtime') {
            const parent = expr.parent;
            if (parent && (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent))) {
                const member = ts.isPropertyAccessExpression(parent) ? parent.name.text : elementName(parent);
                if (member === 'bigint')
                    hit('date', parent);
            }
        }
        if (access.member === 'env' && access.object === 'process' && !literalProcessEnv(expr))
            hit('env', access.node);
        if (access.object === 'date' && access.member === 'getTime' && isNewDate(scope, unwrap(expr).expression))
            hit('date', access.node);
    }

    function noteCall(node) {
        const callee = unwrap(node.expression);
        if (ts.isIdentifier(callee)) {
            if (scope.randomFn.has(callee.text))
                hit('math', node);
            if (scope.dateNowFn.has(callee.text))
                hit('date', node);
            if (callee.text === 'Function') {
                const arg = node.arguments && node.arguments[0] && unwrap(node.arguments[0]);
                if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) && /return\s+this/.test(arg.text))
                    hit('globalThis', node);
            }
            if (callee.text === 'require') {
                const arg = node.arguments && node.arguments[0] && unwrap(node.arguments[0]);
                if (arg && ts.isStringLiteral(arg) && arg.text === 'process') {
                    const parent = node.parent;
                    if (parent && ts.isPropertyAccessExpression(parent) && parent.name.text === 'env')
                        hit('env', parent);
                    if (parent && ts.isElementAccessExpression(parent) && elementName(parent) === 'env')
                        hit('env', parent);
                }
            }
        }
        if (callee && ts.isPropertyAccessExpression(callee) && callee.name.text === 'get'
            && ts.isIdentifier(unwrap(callee.expression)) && unwrap(callee.expression).text === 'Reflect') {
            const target = node.arguments && node.arguments[0];
            const key = node.arguments && node.arguments[1] && unwrap(node.arguments[1]);
            if (target && aliasKind(scope, target) === 'process'
                && key && (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) && key.text === 'env')
                hit('env', node);
        }
        if (callee && ts.isPropertyAccessExpression(callee) && callee.name.text === 'getTime' && isNewDate(scope, callee.expression))
            hit('date', node);
    }

    function visit(node) {
        if (ts.isFunctionLike(node) && node.body) {
            const parentScope = scope;
            scope = newScope(parentScope);
            if (node.parameters) {
                for (const param of node.parameters) {
                    if (param.name)
                        bindPattern(param.name, param.initializer);
                }
            }
            visit(node.body);
            scope = parentScope;
            return;
        }
        if (ts.isVariableDeclaration(node) && node.name) {
            if (node.initializer)
                visit(node.initializer);
            bindPattern(node.name, node.initializer);
            return;
        }
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
            visit(node.right);
            if (ts.isIdentifier(node.left))
                bindPattern(node.left, node.right);
            else if (ts.isObjectLiteralExpression(node.left) && aliasKind(scope, node.right) === 'process') {
                for (const prop of node.left.properties) {
                    const name = ts.isShorthandPropertyAssignment(prop) || ts.isPropertyAssignment(prop)
                        ? propertyName(prop.name)
                        : '';
                    if (name === 'env')
                        hit('env', prop);
                }
            }
            else
                visit(node.left);
            return;
        }
        if (inTypePosition(node) || isDeclarationName(node)) {
            ts.forEachChild(node, visit);
            return;
        }
        if (ts.isIdentifier(node) && node.text === 'globalThis')
            hit('globalThis', node);
        if (ts.isIdentifier(node) && node.text === 'global')
            hit('globalThis', node);
        if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.PlusToken && isNewDate(scope, node.operand))
            hit('date', node);
        if (ts.isCallExpression(node) || ts.isNewExpression(node))
            noteCall(node);
        if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
            noteAccess(node);
        if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
            && node.moduleSpecifier.text === 'process' && node.importClause) {
            const clause = node.importClause;
            const named = clause.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements : [];
            for (const element of named) {
                const imported = element.propertyName ? element.propertyName.text : element.name.text;
                if (imported === 'env')
                    hit('env', element);
            }
        }
        ts.forEachChild(node, visit);
    }

    visit(source);
    return hits;
}

function eachFile(pick) {
    assertSrcTree();
    const hits = [];
    for (const file of walkTs()) {
        if (file.endsWith('.d.ts'))
            continue;
        const found = scanText(file, fs.readFileSync(file, 'utf8'));
        hits.push(...pick(found));
    }
    return [...new Set(hits)];
}

module.exports = {
    SOURCE_PROPS,
    scanText,
    globalThisHits: () => eachFile((hits) => hits.globalThis),
    mathRandomHits: () => eachFile((hits) => hits.math),
    dateNowHits: () => eachFile((hits) => hits.date),
    envEvasionHits: () => eachFile((hits) => hits.env),
};
