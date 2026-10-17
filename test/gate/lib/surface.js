'use strict';
const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const { DIST, SRC } = require('./env');
const { walkTs, relSrc } = require('./src-walk');
const { PUBLIC_EXPORTS, PUBLIC_MEMBERS } = require('./public-surface');

const BANNED_MEMBER = /^(?:__|set[A-Za-z0-9]*For(?:Test|Testing)$)/;
const SKIP_STATIC = new Set(['length', 'name', 'prototype', 'caller', 'arguments']);
const VALUE_FLAGS = ts.SymbolFlags.Function | ts.SymbolFlags.Class | ts.SymbolFlags.Variable | ts.SymbolFlags.Enum;

function compilerOptions() {
    return {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS,
        strict: true,
        esModuleInterop: true,
    };
}

function programOf(files) {
    return ts.createProgram(files, compilerOptions());
}

function resolveAlias(checker, symbol) {
    let current = symbol;
    const seen = new Set();
    while (current.flags & ts.SymbolFlags.Alias && !seen.has(current)) {
        seen.add(current);
        const next = checker.getAliasedSymbol(current);
        if (!next || next === current)
            break;
        current = next;
    }
    return current;
}

function isValueSymbol(checker, symbol) {
    return !!(resolveAlias(checker, symbol).flags & VALUE_FLAGS);
}

function declarationName(symbol) {
    for (const declaration of symbol.getDeclarations() || []) {
        if (declaration.name && ts.isIdentifier(declaration.name))
            return { source: declaration.getSourceFile(), node: declaration.name };
    }
    const declaration = (symbol.getDeclarations() || [])[0];
    if (!declaration)
        return null;
    return { source: declaration.getSourceFile(), node: declaration };
}

function formatDecl(located, suffix) {
    const start = located.node.getStart(located.source);
    const { line } = located.source.getLineAndCharacterOfPosition(start);
    const rel = relSrc(located.source.fileName);
    return `${rel}:${line + 1}: ${suffix}`;
}

let serviceCache = null;

function languageService(files) {
    if (serviceCache)
        return serviceCache;
    const versions = new Map(files.map((file) => [file, '0']));
    const host = {
        getScriptFileNames: () => files,
        getScriptVersion: (file) => versions.get(file) || '0',
        getScriptSnapshot: (file) => {
            if (!fs.existsSync(file))
                return undefined;
            return ts.ScriptSnapshot.fromString(fs.readFileSync(file, 'utf8'));
        },
        getCurrentDirectory: () => path.resolve(SRC, '..'),
        getCompilationSettings: () => compilerOptions(),
        getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
        fileExists: ts.sys.fileExists,
        readFile: ts.sys.readFile,
        readDirectory: ts.sys.readDirectory,
        directoryExists: ts.sys.directoryExists,
        getDirectories: ts.sys.getDirectories,
    };
    serviceCache = ts.createLanguageService(host);
    return serviceCache;
}

function hasSrcCaller(files, located) {
    const start = located.node.getStart(located.source);
    const declFile = path.resolve(located.source.fileName);
    const refs = languageService(files).getReferencesAtPosition(located.source.fileName, start) || [];
    return refs.some((ref) => {
        if (ref.isDefinition)
            return false;
        const sameDeclaration = path.resolve(ref.fileName) === declFile && ref.textSpan.start === start;
        if (sameDeclaration)
            return false;
        return ref.fileName.includes(`${path.sep}src${path.sep}`);
    });
}

function isBannedMember(name) {
    return name.startsWith('__') || BANNED_MEMBER.test(name);
}

function loadRuntimeExports() {
    const entry = path.join(DIST, 'index.js');
    if (!fs.existsSync(entry))
        return { keys: [], classes: [] };
    const pkg = require(entry);
    const classes = [];
    for (const [key, value] of Object.entries(pkg)) {
        if (typeof value === 'function')
            classes.push({ cls: value.name || key, ctor: value });
    }
    return { keys: Object.keys(pkg), classes };
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

function deadExports() {
    const files = walkTs();
    const program = programOf(files);
    const checker = program.getTypeChecker();
    const index = program.getSourceFile(path.join(SRC, 'index.ts'));
    const moduleSymbol = checker.getSymbolAtLocation(index);
    const exported = checker.getExportsOfModule(moduleSymbol);
    const runtime = loadRuntimeExports();
    const names = new Set([
        ...exported.filter((symbol) => isValueSymbol(checker, symbol)).map((symbol) => symbol.getName()),
        ...runtime.keys,
    ]);
    const hits = [];
    for (const name of names) {
        if (PUBLIC_EXPORTS.has(name))
            continue;
        const symbol = exported.find((item) => item.getName() === name);
        const located = symbol ? declarationName(symbol) : null;
        const called = located ? hasSrcCaller(files, located) : false;
        if (called)
            continue;
        if (located)
            hits.push(formatDecl(located, `export ${name} has no src caller and is not on the public API allowlist`));
        else
            hits.push(`index.ts:1: export ${name} has no src caller and is not on the public API allowlist`);
    }
    return hits;
}

function publicMembers(program) {
    const found = [];
    for (const source of program.getSourceFiles()) {
        if (!source.fileName.includes(`${path.sep}src${path.sep}`))
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
                    let name = null;
                    if (member.kind === ts.SyntaxKind.Constructor)
                        name = 'constructor';
                    else if (member.name && (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)))
                        name = member.name.text;
                    if (!name)
                        continue;
                    const nameNode = member.name && ts.isIdentifier(member.name) ? member.name : member;
                    found.push({ cls, name, source, node: nameNode });
                }
            }
            ts.forEachChild(node, visit);
        }
        visit(source);
    }
    return found;
}

function deadMembers() {
    const files = walkTs();
    const program = programOf(files);
    const hits = [];
    const seen = new Set();
    function add(text) {
        if (!seen.has(text)) {
            seen.add(text);
            hits.push(text);
        }
    }
    for (const member of publicMembers(program)) {
        const key = `${member.cls}.${member.name}`;
        const banned = isBannedMember(member.name);
        const allowed = PUBLIC_MEMBERS.has(key);
        if (!banned && allowed)
            continue;
        const located = { source: member.source, node: member.node };
        if (!banned && hasSrcCaller(files, located))
            continue;
        const why = banned
            ? `test-only member ${member.name}`
            : `public member ${member.name} has no src caller and is not on the public API allowlist`;
        add(formatDecl(located, why));
    }
    const runtime = loadRuntimeExports();
    for (const { cls, ctor } of runtime.classes) {
        for (const name of runtimeMemberNames(ctor)) {
            const key = `${cls}.${name}`;
            if (!isBannedMember(name) && PUBLIC_MEMBERS.has(key))
                continue;
            const semantic = publicMembers(program).find((member) => member.cls === cls && member.name === name);
            if (semantic) {
                add(formatDecl({ source: semantic.source, node: semantic.node }, `runtime member ${name}`));
                continue;
            }
            if (isBannedMember(name) || !PUBLIC_MEMBERS.has(key))
                add(`${cls}.ts:1: runtime member ${cls}.${name} is test-only or not on the public API allowlist`);
        }
    }
    return hits;
}

module.exports = { deadExports, deadMembers, isBannedMember };
