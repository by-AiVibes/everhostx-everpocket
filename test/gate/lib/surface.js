'use strict';
// A value export or public member must be reachable from the frozen public API
// or from another src caller. `void f` and export specifiers are not callers.
// Test-only names are rejected even when something calls them.
const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const { DIST, SRC } = require('./env');
const { walkTs, relSrc } = require('./src-walk');
const { assertSrcTree } = require('./src-assert');
const { PUBLIC_EXPORTS, PUBLIC_MEMBERS, PUBLIC_VALUE_EXPORTS } = require('./public-surface');

const BANNED_MEMBER = /^(?:__|set[A-Za-z0-9]*For(?:Test|Testing)$)/;
const SKIP_STATIC = new Set(['length', 'name', 'prototype', 'caller', 'arguments']);
const VALUE_FLAGS = ts.SymbolFlags.Function | ts.SymbolFlags.Class | ts.SymbolFlags.Variable
    | ts.SymbolFlags.Enum | ts.SymbolFlags.ValueModule;

function compilerOptions() {
    return {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS,
        strict: true,
        esModuleInterop: true,
    };
}

function isBannedMember(name) {
    return !!name && (name.startsWith('__') || name.endsWith('ForObservation') || BANNED_MEMBER.test(name));
}

function inSrc(fileName) {
    const rel = path.relative(SRC, fileName);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) && !fileName.endsWith('.d.ts');
}

function programOf(files) {
    return ts.createProgram(files, compilerOptions());
}

function resolveAlias(checker, symbol) {
    let current = symbol;
    const seen = new Set();
    while (current && (current.flags & ts.SymbolFlags.Alias) && !seen.has(current)) {
        seen.add(current);
        const next = checker.getAliasedSymbol(current);
        if (!next || next === current)
            break;
        current = next;
    }
    return current;
}

function isValueSymbol(symbol) {
    return !!(symbol && (symbol.flags & VALUE_FLAGS));
}

function nodeKey(node) {
    const source = node.getSourceFile();
    return `${source.fileName}:${node.getStart(source)}`;
}

function topKey(source) {
    return `top:${source.fileName}`;
}

function classNameOf(node) {
    const parent = node.parent;
    if (parent && ts.isClassDeclaration(parent) && parent.name)
        return parent.name.text;
    return '';
}

function memberNameOf(node) {
    if (ts.isConstructorDeclaration(node))
        return 'constructor';
    if (node.name && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) || ts.isPrivateIdentifier(node.name)))
        return node.name.text;
    return '';
}

function inHeritage(node) {
    let current = node;
    while (current) {
        if (ts.isHeritageClause(current))
            return true;
        current = current.parent;
    }
    return false;
}

function isDirectVoidOperand(node) {
    let current = node;
    while (current && current.parent) {
        if (ts.isFunctionLike(current))
            return false;
        if (ts.isVoidExpression(current.parent) && current.parent.expression === current)
            return true;
        current = current.parent;
    }
    return false;
}

function isSkippedUse(node) {
    if (inHeritage(node))
        return false;
    if (isDirectVoidOperand(node))
        return true;
    let current = node;
    while (current) {
        if (ts.isImportDeclaration(current) || ts.isExportDeclaration(current) || ts.isExportAssignment(current)
            || ts.isImportEqualsDeclaration(current) || ts.isTypeNode(current) || ts.isInterfaceDeclaration(current)
            || ts.isTypeAliasDeclaration(current))
            return true;
        current = current.parent;
    }
    return false;
}

function isDeclarationName(node) {
    const parent = node.parent;
    if (!parent || parent.name !== node)
        return false;
    return ts.isFunctionLike(parent)
        || ts.isClassDeclaration(parent)
        || ts.isClassExpression(parent)
        || ts.isVariableDeclaration(parent)
        || ts.isParameter(parent)
        || ts.isPropertyDeclaration(parent)
        || ts.isModuleDeclaration(parent)
        || ts.isEnumDeclaration(parent)
        || ts.isEnumMember(parent)
        || ts.isInterfaceDeclaration(parent)
        || ts.isTypeAliasDeclaration(parent)
        || ts.isBindingElement(parent)
        || ts.isImportSpecifier(parent)
        || ts.isExportSpecifier(parent)
        || ts.isNamespaceImport(parent)
        || ts.isImportClause(parent);
}

function enclosingKey(node) {
    let current = node.parent;
    while (current) {
        if (ts.isFunctionLike(current) || ts.isClassStaticBlockDeclaration(current))
            return nodeKey(current);
        current = current.parent;
    }
    return topKey(node.getSourceFile());
}

function declarationKey(decl) {
    if (ts.isFunctionLike(decl) || ts.isClassDeclaration(decl) || ts.isClassExpression(decl)
        || ts.isVariableDeclaration(decl) || ts.isEnumDeclaration(decl) || ts.isEnumMember(decl)
        || ts.isModuleDeclaration(decl) || ts.isPropertyDeclaration(decl) || ts.isBindingElement(decl))
        return nodeKey(decl);
    return enclosingKey(decl);
}

function analyze(files) {
    const program = programOf(files.filter((file) => !file.endsWith('.d.ts')));
    const checker = program.getTypeChecker();
    const edges = [];
    const memberUses = new Set();
    const containers = new Map();
    const bodies = new Map();

    function remember(key, info) {
        if (!containers.has(key))
            containers.set(key, info);
    }

    function addEdge(from, to, memberKey) {
        if (!from || !to || from === to)
            return;
        edges.push({ from, to });
        if (memberKey)
            memberUses.add(memberKey);
    }

    for (const source of program.getSourceFiles()) {
        if (!inSrc(source.fileName))
            continue;
        remember(topKey(source), { root: true });
        function visit(node) {
            if (ts.isFunctionLike(node) || ts.isClassStaticBlockDeclaration(node)) {
                const key = nodeKey(node);
                const className = classNameOf(node);
                const memberName = memberNameOf(node);
                const memberKey = className && memberName ? `${className}.${memberName}` : '';
                const exportName = ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)
                    ? (node.name && node.name.text) : '';
                const root = key.startsWith('top:')
                    || (memberKey && PUBLIC_MEMBERS.has(memberKey))
                    || (memberName === 'constructor' && PUBLIC_EXPORTS.has(className))
                    || (exportName && PUBLIC_EXPORTS.has(exportName));
                remember(key, { root, memberKey, exportName, className, node, source });
            }
            if (ts.isClassDeclaration(node) && node.name) {
                const key = nodeKey(node);
                remember(key, {
                    root: PUBLIC_EXPORTS.has(node.name.text),
                    exportName: node.name.text,
                    node,
                    source,
                });
            }
            if (ts.isVariableDeclaration(node) && node.initializer && ts.isFunctionLike(node.initializer))
                bodies.set(nodeKey(node), nodeKey(node.initializer));
            if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node.parent)
                addEdge(enclosingKey(node.parent), nodeKey(node), '');
            if ((ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) && !isDeclarationName(node) && !isSkippedUse(node)) {
                const symbol = checker.getSymbolAtLocation(node);
                const resolved = symbol ? resolveAlias(checker, symbol) : null;
                const decl = resolved && (resolved.getDeclarations() || []).find((item) => inSrc(item.getSourceFile().fileName));
                if (decl) {
                    let target = decl;
                    if (ts.isVariableDeclaration(decl) && decl.initializer && ts.isFunctionLike(decl.initializer))
                        target = decl;
                    const targetKey = declarationKey(decl);
                    const className = classNameOf(decl);
                    const memberName = memberNameOf(decl);
                    let memberKey = className && memberName ? `${className}.${memberName}` : '';
                    if (!memberKey && ts.isClassDeclaration(decl) && decl.name && node.parent && ts.isNewExpression(node.parent))
                        memberKey = `${decl.name.text}.constructor`;
                    addEdge(enclosingKey(node), targetKey, memberKey);
                    if (ts.isVariableDeclaration(decl) && decl.initializer && ts.isFunctionLike(decl.initializer))
                        bodies.set(nodeKey(decl), nodeKey(decl.initializer));
                }
            }
            ts.forEachChild(node, visit);
        }
        visit(source);
    }

    const live = new Set();
    for (const [key, info] of containers) {
        if (info.root)
            live.add(key);
    }
    let changed = true;
    while (changed) {
        changed = false;
        for (const key of [...live]) {
            const body = bodies.get(key);
            if (body && !live.has(body)) {
                live.add(body);
                changed = true;
            }
        }
        for (const edge of edges) {
            if (live.has(edge.from) && !live.has(edge.to)) {
                live.add(edge.to);
                changed = true;
            }
        }
    }
    return { program, checker, live, memberUses, containers, edges };
}

function sourceFiles(program) {
    return program.getSourceFiles();
}

function formatAt(source, node, suffix) {
    const start = node.getStart(source);
    const { line } = source.getLineAndCharacterOfPosition(start);
    return `${relSrc(source.fileName)}:${line + 1}: ${suffix}`;
}

function exportedSymbols(checker, source) {
    const moduleSymbol = checker.getSymbolAtLocation(source);
    if (!moduleSymbol)
        return [];
    const found = [];
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
        const resolved = resolveAlias(checker, exported);
        if (!resolved || !isValueSymbol(resolved))
            continue;
        const decl = (resolved.getDeclarations() || []).find((item) => inSrc(item.getSourceFile().fileName));
        if (!decl)
            continue;
        const aliasDecl = (exported.getDeclarations() || []).find((item) => ts.isExportSpecifier(item) && inSrc(item.getSourceFile().fileName));
        found.push({
            name: resolved.getName() === 'default' ? exported.getName() : resolved.getName(),
            resolvedName: resolved.getName(),
            exportName: exported.getName(),
            decl,
            source: decl.getSourceFile(),
            reexport: aliasDecl && aliasDecl.getSourceFile() !== decl.getSourceFile() ? aliasDecl : null,
        });
    }
    return found;
}

function deadExports() {
    const files = assertSrcTree();
    const { program, checker, live } = analyze(files);
    const hits = [];
    const seen = new Set();
    for (const source of sourceFiles(program)) {
        if (!inSrc(source.fileName))
            continue;
        for (const item of exportedSymbols(checker, source)) {
            const valueKey = `${relSrc(item.source.fileName)}:${item.resolvedName === 'default' ? item.exportName : item.resolvedName}`;
            if (PUBLIC_EXPORTS.has(item.resolvedName) || PUBLIC_EXPORTS.has(item.name) || PUBLIC_EXPORTS.has(item.exportName)
                || PUBLIC_VALUE_EXPORTS.has(valueKey))
                continue;
            const key = nodeKey(item.decl);
            if (live.has(key))
                continue;
            const label = item.resolvedName === 'default' ? item.exportName : item.resolvedName;
            const sites = [formatAt(item.source, item.decl, `export ${label} has no src caller and is not on the public API allowlist`)];
            if (item.reexport)
                sites.push(formatAt(item.reexport.getSourceFile(), item.reexport, `export ${item.exportName} has no src caller and is not on the public API allowlist`));
            for (const text of sites) {
                if (!seen.has(text)) {
                    seen.add(text);
                    hits.push(text);
                }
            }
        }
    }
    return hits;
}

function semanticMembers(program) {
    const found = [];
    for (const source of program.getSourceFiles()) {
        if (!inSrc(source.fileName))
            continue;
        function visit(node) {
            if (ts.isClassDeclaration(node) && node.name) {
                const cls = node.name.text;
                for (const member of node.members) {
                    if (member.name && ts.isPrivateIdentifier(member.name))
                        continue;
                    const mods = ts.getCombinedModifierFlags(member);
                    if (mods & ts.ModifierFlags.Private || mods & ts.ModifierFlags.Protected)
                        continue;
                    const name = memberNameOf(member);
                    if (!name)
                        continue;
                    const nameNode = member.name && (ts.isIdentifier(member.name) || ts.isPrivateIdentifier(member.name))
                        ? member.name
                        : member;
                    found.push({ cls, name, source, node: nameNode, member });
                }
            }
            ts.forEachChild(node, visit);
        }
        visit(source);
    }
    return found;
}

function loadRuntimeExports() {
    const entry = path.join(DIST, 'index.js');
    if (!fs.existsSync(entry))
        return [];
    const pkg = require(entry);
    const classes = [];
    for (const [key, value] of Object.entries(pkg)) {
        if (typeof value === 'function')
            classes.push({ cls: value.name || key, ctor: value });
    }
    return classes;
}

function runtimeMemberNames(ctor) {
    const names = [];
    for (const name of Object.getOwnPropertyNames(ctor.prototype || {})) {
        if (name !== 'constructor')
            names.push(name);
    }
    for (const name of Object.getOwnPropertyNames(ctor)) {
        if (!SKIP_STATIC.has(name))
            names.push(name);
    }
    return names;
}

function deadMembers() {
    const files = assertSrcTree();
    const { program, memberUses } = analyze(files);
    const hits = [];
    const seen = new Set();
    function add(text) {
        if (!seen.has(text)) {
            seen.add(text);
            hits.push(text);
        }
    }
    const members = semanticMembers(program);
    for (const member of members) {
        const key = `${member.cls}.${member.name}`;
        const banned = isBannedMember(member.name);
        const allowed = PUBLIC_MEMBERS.has(key);
        const called = memberUses.has(key);
        if (!banned && (called || allowed))
            continue;
        const why = banned
            ? `test-only member ${member.name}`
            : `public member ${member.name} has no src caller and is not on the public API allowlist`;
        add(formatAt(member.source, member.node, why));
    }
    for (const { cls, ctor } of loadRuntimeExports()) {
        for (const name of runtimeMemberNames(ctor)) {
            const key = `${cls}.${name}`;
            const banned = isBannedMember(name);
            const allowed = PUBLIC_MEMBERS.has(key);
            const called = memberUses.has(key);
            if (!banned && (called || allowed))
                continue;
            const semantic = members.find((member) => member.cls === cls && member.name === name);
            if (semantic)
                continue;
            add(`${cls}.ts:1: runtime member ${cls}.${name} is test-only or not on the public API allowlist`);
        }
    }
    return hits;
}

module.exports = { deadExports, deadMembers, isBannedMember };
