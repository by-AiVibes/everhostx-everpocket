'use strict';
// aborts == 0 companions for every #5 sim scenario. noDivergence and atMostOnce
// stay green when every node aborts; these do not.
const test = require('node:test');
const { scen, EXT, NODES, m32 } = require('./lib/sim/run');
const { assertNoAborts } = require('./lib/assert-round');

async function check(name, options) {
    assertNoAborts(await scen(name, options));
}

test.describe('aborts companions', { concurrency: 1 }, () => {
    for (let seed = 0; seed < 10; seed++) {
        test(`seed ${seed} aborts == 0`, async () => {
            const rng = m32(seed + 21);
            const plan = {};
            await check(`seed${seed}`, {
                nodes: NODES,
                rounds: 100,
                jitter: true,
                drop: 0.2,
                rng,
                ops: [EXT('C'), EXT('D'), EXT('A'), EXT('E')],
                modes: (id, round) => {
                    const key = id + round;
                    if (!(key in plan)) {
                        const roll = rng();
                        plan[key] = id === 'A' && seed % 2 === 0
                            ? 'liehash'
                            : roll < 0.1
                                ? 'extfail'
                                : roll < 0.2
                                    ? 'throwafter'
                                    : roll < 0.25
                                        ? 'crash'
                                        : roll < 0.32
                                            ? 'seqfail'
                                            : 'ok';
                    }
                    return plan[key];
                },
            });
        });
    }

    test('seed-3 double-pay aborts == 0', async () => {
        const seed = 3;
        const rng = m32(seed + 21);
        const plan = {};
        await check('seed3', {
            nodes: NODES,
            rounds: 100,
            jitter: true,
            drop: 0.2,
            rng,
            ops: [EXT('C'), EXT('D'), EXT('A'), EXT('E')],
            modes: (id, round) => {
                const key = id + round;
                if (!(key in plan)) {
                    const roll = rng();
                    plan[key] = roll < 0.1 ? 'extfail' : roll < 0.2 ? 'throwafter' : roll < 0.25 ? 'crash' : roll < 0.32 ? 'seqfail' : 'ok';
                }
                return plan[key];
            },
        });
    });

    test('OVERLAP aborts == 0', async () => {
        await check('OVERLAP', {
            nodes: NODES,
            rounds: 50,
            ops: [EXT('C'), EXT('D')],
            modes: (id, round) => (round < 3 && id !== 'E' ? 'throwafter' : 'ok'),
        });
    });

    test('LAG aborts == 0', async () => {
        await check('LAG', {
            nodes: NODES,
            rounds: 40,
            ops: [EXT('C')],
            lag: (round, ledger) => ({ B: ledger.validated - 40 }),
        });
    });

    test('NOLAG aborts == 0', async () => {
        await check('NOLAG', { nodes: NODES, rounds: 20, ops: [EXT('C')] });
    });

    test('LIAR liehash aborts == 0', async () => {
        await check('LIAR-liehash', {
            nodes: NODES,
            rounds: 40,
            ops: [EXT('C')],
            modes: (id) => (id === 'A' ? 'liehash' : 'ok'),
        });
    });

    test('LIAR lieidx aborts == 0', async () => {
        await check('LIAR-lieidx', {
            nodes: NODES,
            rounds: 40,
            ops: [EXT('C')],
            modes: (id) => (id === 'A' ? 'lieidx' : 'ok'),
        });
    });

    test('TXNULL aborts == 0', async () => {
        await check('TXNULL', {
            nodes: NODES,
            rounds: 40,
            ops: [EXT('C')],
            modes: (id) => (id === 'B' ? 'txnull' : 'ok'),
        });
    });

    test('SEQFAIL aborts == 0', async () => {
        await check('SEQFAIL', {
            nodes: NODES,
            rounds: 40,
            ops: [EXT('C'), EXT('D')],
            modes: (id) => (id === 'B' ? 'seqfail' : 'ok'),
        });
    });

    test('REALHASH aborts == 0', async () => {
        await check('REALHASH', { nodes: NODES, rounds: 40, ops: [EXT('C'), EXT('D')] });
    });

    test('RESTART aborts == 0', async () => {
        await check('RESTART', {
            nodes: NODES,
            rounds: 40,
            ops: [EXT('C')],
            modes: (id, round) => (round === 1 ? 'throwafter+crash' : 'ok'),
        });
    });

    test('COLLUDE2 aborts == 0', async () => {
        await check('COLLUDE2', {
            nodes: NODES,
            rounds: 30,
            ops: [EXT('C')],
            modes: (id) => (id === 'A' || id === 'B' ? 'collude' : 'ok'),
        });
    });
});
