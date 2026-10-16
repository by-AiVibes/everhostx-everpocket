const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const { createWorkDir } = require('./test-workdir');
const { writeAcquiresFile, writeClusterFiles, defaultClusterNode, DEFAULT_ANCHOR, DEFAULT_TENANT_SEQUENCE, TENANT_ADDRESS } = require('./cluster-test-helpers');
const { initLedger, readLedger, writeLedger, writePinnedRound, mergeSubmitIntents } = require('./shared-ledger-store');
const { OperationType } = require('../../dist/models/cluster');

const NODE_COUNT = 5;
const EXTEND_PUBKEY = 'sim_extend_pubkey';
const SHARED_LCL_HASH = 'cafebabe00cafebabe00cafebabe00cafebabe';

function stateSha256(dir) {
    const ops = fs.readFileSync(path.join(dir, 'operations.json'));
    const cluster = fs.readFileSync(path.join(dir, 'cluster.json'));
    const acquires = fs.readFileSync(path.join(dir, 'acquires.json'));
    return crypto.createHash('sha256').update(ops).update(cluster).update(acquires).digest('hex');
}

function seedNodeDirs(workRoot) {
    const dirs = [];
    for (let i = 0; i < NODE_COUNT; i++) {
        const dir = `n${i}`;
        const full = path.join(workRoot, dir);
        fs.mkdirSync(full, { recursive: true });
        fs.writeFileSync(path.join(full, 'acquires.json'), JSON.stringify({ acquiredNodes: [], pendingAcquires: [] }));
        fs.writeFileSync(path.join(full, 'cluster.json'), JSON.stringify({
            initialized: true,
            nodes: [{
                ...defaultClusterNode(EXTEND_PUBKEY),
                lifeMoments: 1,
                targetLifeMoments: 200,
            }],
            pendingNodes: [],
        }, null, 4));
        fs.writeFileSync(path.join(full, 'operations.json'), JSON.stringify({
            operations: [{
                type: OperationType.EXTEND_NODE,
                ref: EXTEND_PUBKEY,
                data: { nodePubkey: EXTEND_PUBKEY, moments: 1 },
            }],
            anchorLedger: DEFAULT_ANCHOR,
        }, null, 4));
        dirs.push(dir);
    }
    return dirs;
}

function runChild(workRoot, nodeDir, seed, round, lcl) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(__dirname, 'queue-sim-child.js')], {
            env: {
                ...process.env,
                EVP_WORK_ROOT: workRoot,
                EVP_NODE_DIR: nodeDir,
                EVP_NODE_ID: nodeDir,
                EVP_SEED: String(seed),
                EVP_ROUND: String(round),
                EVP_LCL: String(lcl),
                EVP_LCL_HASH: SHARED_LCL_HASH,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.stderr.on('data', (d) => { process.stderr.write(d); });
        child.on('exit', (code) => {
            if (code !== 0)
                reject(new Error(`child ${nodeDir} exit ${code}`));
            else {
                const resultPath = path.join(workRoot, nodeDir, '.evp-round-result.json');
                resolve(JSON.parse(fs.readFileSync(resultPath, 'utf8')));
            }
        });
    });
}

describe('queue-sim multiprocess (phase 1)', () => {
    let workRoot;
    let originalCwd;

    beforeEach(() => {
        originalCwd = process.cwd();
        workRoot = createWorkDir('evp-mp-sim');
        initLedger(workRoot, {
            anchor: DEFAULT_ANCHOR,
            tenantSequence: DEFAULT_TENANT_SEQUENCE,
            tenantAddress: TENANT_ADDRESS,
        });
    });

    afterEach(() => {
        process.chdir(originalCwd);
        fs.rmSync(workRoot, { recursive: true, force: true });
    });

    it('10 seeds, 5 forked nodes, divergent validated indexes, partial submit failures', async () => {
        for (let seed = 0; seed < 10; seed++) {
            const seedRoot = path.join(workRoot, `seed-${seed}`);
            fs.mkdirSync(seedRoot, { recursive: true });
            initLedger(seedRoot, {
                anchor: DEFAULT_ANCHOR,
                tenantSequence: DEFAULT_TENANT_SEQUENCE,
                tenantAddress: TENANT_ADDRESS,
            });
            const dirs = seedNodeDirs(seedRoot);
            const rounds = 5 + (seed % 6);

            for (let round = 0; round < rounds; round++) {
                const ledger = readLedger(seedRoot);
                const baseValidated = DEFAULT_ANCHOR + 30 + round;
                ledger.globalValidatedIndex = baseValidated;
                for (let i = 0; i < NODE_COUNT; i++)
                    ledger.nodeValidated[`n${i}`] = baseValidated + (i % 3);
                writeLedger(seedRoot, ledger);
                const anchorForPin = JSON.parse(fs.readFileSync(path.join(seedRoot, 'n0', 'operations.json'), 'utf8')).anchorLedger;
                writePinnedRound(seedRoot, round, {
                    anchor: anchorForPin,
                    tenantAddress: TENANT_ADDRESS,
                    tenantSequence: DEFAULT_TENANT_SEQUENCE,
                });

                const lcl = 100 + seed * 10 + round * 4;
                const results = [];
                for (const d of dirs)
                    results.push(await runChild(seedRoot, d, seed, round, lcl));
                assert.strictEqual(results.length, NODE_COUNT);

                const hashes = dirs
                    .filter((_, i) => !results[i].aborted)
                    .map((d) => stateSha256(path.join(seedRoot, d)));
                if (hashes.length > 0) {
                    const first = hashes[0];
                    for (const h of hashes)
                        assert.strictEqual(h, first);
                }

                mergeSubmitIntents(seedRoot, round);
            }
        }
    });
});
