'use strict';
// Resolves the build under test. GATE_DIST / GATE_SRC let the suite run against any checkout.
const path = require('path');
const repo = path.resolve(__dirname, '..', '..', '..');
const DIST = path.resolve(process.env.GATE_DIST || path.join(repo, 'dist'));
const SRC = path.resolve(process.env.GATE_SRC || path.join(repo, 'src'));
function requireDist(rel) { return require(rel ? path.join(DIST, rel) : DIST); }
module.exports = { DIST, SRC, requireDist };
