'use strict';
// 10-seed multi-process sim: partial delivery (20% drop), mixed local views (jitter), partial failures,
// failing sequence reader, and a 1/5 hash liar on even seeds. 0 divergence, every op completes, landed == 1.
const test = require('node:test');
const { scen, EXT, NODES, m32 } = require('./lib/sim/run');
const S = require('./lib/assert-sim');
for (let s = 0; s < 10; s++) {
    test(`seed ${s} x 100 rounds`, { timeout: 900000 }, async () => {
        const rng = m32(s + 21), plan = {};
        const out = await scen('seed' + s, { nodes: NODES, rounds: 100, jitter: true, drop: 0.2, rng, ops: [EXT('C'), EXT('D'), EXT('A'), EXT('E')],
            modes: (i, rd) => { const k = i + rd; if (!(k in plan)) { const x = rng(); plan[k] = i === 'A' && s % 2 === 0 ? 'liehash' : x < 0.1 ? 'extfail' : x < 0.2 ? 'throwafter' : x < 0.25 ? 'crash' : x < 0.32 ? 'seqfail' : 'ok'; } return plan[k]; } });
        S.noDivergence(out); S.allCompleteLandedOnce(out);
    });
}
