const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { createWorkDir } = require('./test-workdir');
const { defaultClusterNode } = require('./cluster-test-helpers');
const {
    initNodeDirs,
    runAllNodesOneRound,
    assertHashConsensus,
    resetNodeContexts,
    FakeXahauLedger,
    extendOp,
    DEFAULT_ANCHOR,
} = require('./queue-sim-harness');

const EXTEND_PUBKEY = 'sim_extend_pubkey';

describe('queue-sim extend (phase 1)', () => {
    let workRoot;
    let originalCwd;
    let ledger;

    beforeEach(() => {
        originalCwd = process.cwd();
        workRoot = createWorkDir('evp-queue-sim-extend');
        ledger = new FakeXahauLedger();
        ledger.setGlobalValidatedIndex(DEFAULT_ANCHOR);
        resetNodeContexts();
    });

    afterEach(() => {
        resetNodeContexts();
        process.chdir(originalCwd);
        fs.rmSync(workRoot, { recursive: true, force: true });
    });

    it('10 seeds x 100 rounds: no divergence with partial extend throws', async () => {
        for (let seed = 0; seed < 10; seed++) {
            const seedRoot = path.join(workRoot, `seed-${seed}`);
            fs.mkdirSync(seedRoot, { recursive: true });
            const dirs = initNodeDirs(seedRoot, seed + 1, () => ({
                nodes: [{
                    ...defaultClusterNode(EXTEND_PUBKEY),
                    lifeMoments: 1,
                    targetLifeMoments: 100,
                }],
                pendingNodes: [],
                operations: [extendOp(EXTEND_PUBKEY, 1)],
            }));

            for (let round = 0; round < 100; round++) {
                ledger.setGlobalValidatedIndex(DEFAULT_ANCHOR + round);
                const lcl = 100 + round * 4;
                const { hashes } = await runAllNodesOneRound({
                    dirs,
                    ledger,
                    lcl,
                    hooks: {
                        round,
                        simOptions: { throwAllUntilRound: 3 },
                    },
                });
                if (hashes.length > 0)
                    assertHashConsensus(hashes);
            }
        }
    });
});
