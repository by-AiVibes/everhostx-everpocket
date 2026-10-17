'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..'), FILE = path.join(ROOT, 'MANIFEST.sha256');
function walk(d) { return fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]); }
function compute() {
    const m = {};
    for (const f of walk(ROOT).filter(f => f !== FILE).sort()) m[path.relative(ROOT, f)] = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    m['../../docs/acceptance.md'] = crypto.createHash('sha256').update(fs.readFileSync(path.resolve(ROOT, '../../docs/acceptance.md'))).digest('hex');
    return m;
}
function read() { const m = {}; for (const l of fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean)) { const [h, f] = l.split(/\s+/); m[f] = h; } return m; }
if (process.argv.includes('--write')) fs.writeFileSync(FILE, Object.entries(compute()).map(([f, h]) => `${h}  ${f}`).join('\n') + '\n');
module.exports = { compute, read };
