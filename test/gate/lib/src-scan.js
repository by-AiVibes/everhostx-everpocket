'use strict';
const ts = require('typescript');
const fs = require('fs');
const { walkTs, relSrc } = require('./src-walk');

const SOURCE_PROPS = new Set(['lclHash', 'publicKey', 'lclSeqNo', 'opRef']);

function parse(file) {
    const text = fs.readFileSync(file, 'utf8');
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    return { text, source, lines: text.split('\n') };
}

function at(file, source, node) {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    return `${relSrc(file)}:${line + 1}: ${(lines[line] || '').trim()}`;
}

function eachFile(visit) {
    const hits = [];
    for (const file of walkTs()) {
        const parsed = parse(file);
        visit(parsed.source, (node) => hits.push(at(file, parsed.source, node)));
    }
    return hits;
}

function globalThisHits() {
    return eachFile((source, hit) => {
        function visit(node) {
            if (ts.isIdentifier(node) && node.text === 'globalThis')
                hit(node);
            ts.forEachChild(node, visit);
        }
        visit(source);
    });
}

function memberCallHits(objectName, memberName) {
    return eachFile((source, hit) => {
        function visit(node) {
            if (ts.isPropertyAccessExpression(node)
                && node.name.text === memberName
                && ts.isIdentifier(node.expression)
                && node.expression.text === objectName)
                hit(node);
            if (ts.isElementAccessExpression(node)
                && ts.isIdentifier(node.expression)
                && node.expression.text === objectName
                && node.argumentExpression
                && ts.isStringLiteral(node.argumentExpression)
                && node.argumentExpression.text === memberName)
                hit(node);
            ts.forEachChild(node, visit);
        }
        visit(source);
    });
}

function boundEnvName(name) {
    if (!name)
        return '';
    if (ts.isIdentifier(name))
        return name.text;
    return '';
}

function envEvasionHits() {
    return eachFile((source, hit) => {
        function visit(node) {
            if (ts.isVariableDeclaration(node)
                && node.initializer
                && ts.isIdentifier(node.initializer)
                && node.initializer.text === 'process'
                && ts.isObjectBindingPattern(node.name)) {
                for (const element of node.name.elements) {
                    const property = element.propertyName ? boundEnvName(element.propertyName) : boundEnvName(element.name);
                    if (property === 'env')
                        hit(node);
                }
            }
            if (ts.isElementAccessExpression(node)
                && ts.isIdentifier(node.expression)
                && node.expression.text === 'process'
                && node.argumentExpression
                && ts.isStringLiteral(node.argumentExpression)
                && node.argumentExpression.text === 'env')
                hit(node);
            ts.forEachChild(node, visit);
        }
        visit(source);
    });
}

module.exports = {
    SOURCE_PROPS,
    globalThisHits,
    mathRandomHits: () => memberCallHits('Math', 'random'),
    dateNowHits: () => memberCallHits('Date', 'now'),
    envEvasionHits,
};
