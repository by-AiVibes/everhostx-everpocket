import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const listPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'expected-red.txt');

function loadExpected() {
    if (!fs.existsSync(listPath))
        return [];
    const rows = [];
    for (const line of fs.readFileSync(listPath, 'utf8').split('\n')) {
        if (!line.trim() || line.trim().startsWith('#'))
            continue;
        const parts = line.split(' | ');
        if (parts.length < 4)
            continue;
        rows.push({
            file: parts[0].trim(),
            name: parts[1].trim(),
            tag: parts[2].trim(),
            message: parts.slice(3).join(' | ').trim(),
        });
    }
    return rows;
}

function gateFile(file) {
    if (!file)
        return '';
    const norm = String(file).split('\\').join('/');
    const marker = '/test/gate/';
    const index = norm.indexOf(marker);
    return index >= 0 ? norm.slice(index + marker.length) : path.basename(norm);
}

function keyOf(file, name) {
    return `${gateFile(file)} | ${name}`;
}

function messageOf(data) {
    const error = data && data.details && data.details.error;
    if (!error)
        return '';
    return `${error.message || error}`;
}

export default async function* expectReporter(source) {
    const expected = loadExpected();
    const fails = [];
    const passes = [];
    for await (const event of source) {
        const data = event.data || {};
        if (!data.name || !data.file)
            continue;
        if (event.type === 'test:pass' && !(data.details && (data.details.skip || data.details.todo)))
            passes.push({ file: gateFile(data.file), name: data.name });
        if (event.type === 'test:fail')
            fails.push({ file: gateFile(data.file), name: data.name, message: messageOf(data) });
    }
    const problems = [];
    const failByKey = new Map();
    for (const fail of fails)
        failByKey.set(keyOf(fail.file, fail.name), fail);
    const passKeys = new Set(passes.map((item) => keyOf(item.file, item.name)));
    for (const row of expected) {
        const key = keyOf(row.file, row.name);
        const fail = failByKey.get(key);
        if (passKeys.has(key))
            problems.push(`listed test passed: ${key}`);
        else if (!fail)
            problems.push(`listed test did not fail: ${key}`);
        else if (!fail.message.includes(row.message))
            problems.push(`message mismatch: ${key}\n  expected substring: ${row.message}\n  got: ${fail.message}`);
    }
    for (const [key, fail] of failByKey) {
        if (!expected.some((row) => keyOf(row.file, row.name) === key))
            problems.push(`unlisted red: ${key} | ${fail.message.split('\n')[0]}`);
    }
    if (process.env.GATE_EXPECT_RECORD === '1') {
        const draft = fails
            .map((fail) => `${fail.file} | ${fail.name} | TODO | ${fail.message.split('\n')[0]}`)
            .join('\n');
        fs.writeFileSync('/tmp/gate-expected-red.draft.txt', `${draft}\n`);
    }
    const verdict = problems.length === 0 ? 0 : 1;
    process.on('exit', () => {
        process.exitCode = verdict;
    });
    if (verdict === 0)
        console.error(`expected-red reporter: exact match (${expected.length} expected red)`);
    else
        console.error(`expected-red reporter: FAIL\n${problems.join('\n')}`);
}
