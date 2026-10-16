const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const NomadContext = require('../../dist/context/NomadContext').default;
const {
    DEFAULT_INACTIVE_PRUNE_LCL_THRESHOLD,
    DEFAULT_IMMATURE_PRUNE_LCL_THRESHOLD,
    DEFAULT_EXPIRE_PRUNE_TS_THRESHOLD,
} = require('../../dist/context/NomadContext');
const { createWorkDir } = require('./test-workdir');
const { writeAcquiresFile, writeClusterFiles, defaultClusterNode, buildClusterContext } = require('./cluster-test-helpers');

const INACTIVE_PUBKEY = 'inactive_unl_prune_pubkey';
const IMMATURE_PUBKEY = 'immature_prune_pubkey';

describe('Fix 4: configurable prune thresholds', () => {
    let tmpDir;
    let originalCwd;

    beforeEach(() => {
        tmpDir = createWorkDir('evp-prune-thresholds');
        originalCwd = process.cwd();
        process.chdir(tmpDir);
        writeAcquiresFile();
    });

    afterEach(() => {
        process.chdir(originalCwd);
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('exposes defaults matching legacy constants', () => {
        assert.strictEqual(DEFAULT_INACTIVE_PRUNE_LCL_THRESHOLD, 60);
        assert.strictEqual(DEFAULT_IMMATURE_PRUNE_LCL_THRESHOLD, 15);
        assert.strictEqual(DEFAULT_EXPIRE_PRUNE_TS_THRESHOLD, 900000);
    });

    function buildNomad(options, nodes) {
        writeClusterFiles({ nodes, pendingNodes: [], operations: [] });
        const clusterCtx = buildClusterContext({
            getEvernodeConfig: () => ({ momentSize: 1000 }),
        }, {
            lclSeqNo: 200,
            timestamp: 1_000_000,
            getContractUnl: () => nodes.filter((n) => n.isUnl).map((n) => ({ publicKey: n.pubkey })),
        });
        return new NomadContext(clusterCtx, {
            targetNodeCount: 1,
            lifeIncrMomentMinLimit: 1,
            parallelGrow: true,
            ...options,
        });
    }

    it('uses default inactive threshold (no prune below legacy cutoff)', async () => {
        const nomad = buildNomad({}, [{
            ...defaultClusterNode(INACTIVE_PUBKEY),
            isUnl: true,
            status: { status: 1, onLcl: 100 },
            activeOnLcl: 200 - 59,
        }]);
        await nomad.prune();
        await nomad.clusterContext.deinit();
        let ops = JSON.parse(fs.readFileSync('operations.json', 'utf8'));
        assert.strictEqual(ops.operations.length, 0);

        const nomad2 = buildNomad({}, [{
            ...defaultClusterNode(INACTIVE_PUBKEY),
            isUnl: true,
            status: { status: 1, onLcl: 100 },
            activeOnLcl: 200 - 61,
        }]);
        await nomad2.prune();
        await nomad2.clusterContext.deinit();
        ops = JSON.parse(fs.readFileSync('operations.json', 'utf8'));
        assert.strictEqual(ops.operations.length, 1);
        assert.strictEqual(ops.operations[0].ref, INACTIVE_PUBKEY);
    });

    it('prunes inactive UNL sooner when inactivePruneLcl is lowered', async () => {
        const nomad = buildNomad({ inactivePruneLcl: 10 }, [{
            ...defaultClusterNode(INACTIVE_PUBKEY),
            isUnl: true,
            status: { status: 1, onLcl: 100 },
            activeOnLcl: 200 - 11,
        }]);
        await nomad.prune();
        await nomad.clusterContext.deinit();
        const ops = JSON.parse(fs.readFileSync('operations.json', 'utf8'));
        assert.strictEqual(ops.operations.length, 1);

        fs.writeFileSync('operations.json', JSON.stringify({ operations: [] }));
        const nomad2 = buildNomad({ inactivePruneLcl: 10 }, [{
            ...defaultClusterNode(INACTIVE_PUBKEY),
            isUnl: true,
            status: { status: 1, onLcl: 100 },
            activeOnLcl: 200 - 9,
        }]);
        await nomad2.prune();
        await nomad2.clusterContext.deinit();
        const ops2 = JSON.parse(fs.readFileSync('operations.json', 'utf8'));
        assert.strictEqual(ops2.operations.length, 0);
    });

    it('uses custom immaturePruneLcl for non-UNL CREATED nodes', async () => {
        const nomad = buildNomad({ immaturePruneLcl: 5 }, [{
            ...defaultClusterNode(IMMATURE_PUBKEY),
            isUnl: false,
            status: { status: 1, onLcl: 190 },
        }]);
        await nomad.prune();
        await nomad.clusterContext.deinit();
        const ops = JSON.parse(fs.readFileSync('operations.json', 'utf8'));
        assert.strictEqual(ops.operations.length, 1);
    });
});
