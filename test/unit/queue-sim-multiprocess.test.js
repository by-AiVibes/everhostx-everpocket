const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const { createWorkDir } = require('./test-workdir');
const { writeAcquiresFile, writeClusterFiles, defaultClusterNode, DEFAULT_ANCHOR, DEFAULT_TENANT_SEQUENCE, TENANT_ADDRESS } = require('./cluster-test-helpers');
const { initLedger, readLedger, writeLedger, writePinnedRound, mergeSubmitIntents, ledgerHashAt } = require('./shared-ledger-store');
const { OperationType } = require('../../dist/models/cluster');

const NODE_COUNT = 5;
const EXTEND_PUBKEY = 'sim_extend_pubkey';
const SHARED_LCL_HASH = 'cafebabe00cafebabe00cafebabe00cafebabe';
const ROUNDS_PER_SEED = 100;
const SEED_COUNT = 10;

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
            agreedTenantSequence: DEFAULT_TENANT_SEQUENCE,
        }, null, 4));
        dirs.push(dir);
    }
    return dirs;
}

function runChild(workRoot, nodeDir, seed, round, lcl, phase, extraEnv = {}) {
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
                EVP_PHASE: phase,
                ...extraEnv,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.stderr.on('data', (d) => { process.stderr.write(d); });
        child.on('exit', (code) => {
            if (code !== 0)
                reject(new Error(`child ${nodeDir} ${phase} exit ${code}`));
            else if (phase === 'exec') {
                const resultPath = path.join(workRoot, nodeDir, '.evp-round-result.json');
                resolve(JSON.parse(fs.readFileSync(resultPath, 'utf8')));
            } else
                resolve({ nodeId: nodeDir });
        });
    });
}

function mergePartialObservations(seedRoot, seed, round) {
    const inboxDir = path.join(seedRoot, 'inbox');
    const files = fs.readdirSync(inboxDir)
        .filter((f) => f.startsWith(`seed-${seed}-r${round}-`))
        .map((f) => JSON.parse(fs.readFileSync(path.join(inboxDir, f), 'utf8')));
    const dropIdx = (seed + round) % NODE_COUNT;
    const messages = files.filter((_, idx) => idx !== dropIdx);
    assert.strictEqual(messages.length, NODE_COUNT - 1);
    fs.writeFileSync(path.join(seedRoot, `consensus-inputs-r${round}.json`), JSON.stringify({ messages }));
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

    it(`${SEED_COUNT} seeds x ${ROUNDS_PER_SEED} rounds: node-produced observations, partial delivery, 0 divergence`, async () => {
        for (let seed = 0; seed < SEED_COUNT; seed++) {
            const seedRoot = path.join(workRoot, `seed-${seed}`);
            fs.mkdirSync(seedRoot, { recursive: true });
            fs.mkdirSync(path.join(seedRoot, 'inbox'), { recursive: true });
            initLedger(seedRoot, {
                anchor: DEFAULT_ANCHOR,
                tenantSequence: DEFAULT_TENANT_SEQUENCE,
                tenantAddress: TENANT_ADDRESS,
            });
            const dirs = seedNodeDirs(seedRoot);
            let maxAnchorSeen = DEFAULT_ANCHOR;

            for (let round = 0; round < ROUNDS_PER_SEED; round++) {
                const ledger = readLedger(seedRoot);
                const anchorForPin = JSON.parse(fs.readFileSync(path.join(seedRoot, 'n0', 'operations.json'), 'utf8')).anchorLedger;
                const baseValidated = anchorForPin + 25 + round;
                ledger.globalValidatedIndex = baseValidated;
                for (let i = 0; i < NODE_COUNT; i++) {
                    const lagRound = (seed + round) % 17 === 0;
                    ledger.nodeValidated[`n${i}`] = lagRound
                        ? anchorForPin - 2 - (i % 2)
                        : baseValidated + (i % 3);
                }
                writeLedger(seedRoot, ledger);
                writePinnedRound(seedRoot, round, {
                    anchor: anchorForPin,
                    tenantAddress: TENANT_ADDRESS,
                    tenantSequence: DEFAULT_TENANT_SEQUENCE,
                });

                const lcl = 100 + seed * 10 + round * 4;
                for (const d of dirs)
                    await runChild(seedRoot, d, seed, round, lcl, 'observe');
                mergePartialObservations(seedRoot, seed, round);

                const results = [];
                for (const d of dirs)
                    results.push(await runChild(seedRoot, d, seed, round, lcl, 'exec'));
                assert.strictEqual(results.length, NODE_COUNT);

                const hashes = dirs
                    .filter((_, i) => !results[i].aborted)
                    .map((d) => stateSha256(path.join(seedRoot, d)));
                assert.ok(hashes.length > 0);
                const first = hashes[0];
                for (const h of hashes)
                    assert.strictEqual(h, first);

                mergeSubmitIntents(seedRoot, round);
                const curAnchor = JSON.parse(fs.readFileSync(path.join(seedRoot, 'n0', 'operations.json'), 'utf8')).anchorLedger;
                maxAnchorSeen = Math.max(maxAnchorSeen, curAnchor);
            }

            assert.ok(maxAnchorSeen > DEFAULT_ANCHOR,
                `seed ${seed}: anchor must advance under mixed local views (max ${maxAnchorSeen})`);

            const ledger = readLedger(seedRoot);
            assert.strictEqual(ledger.landedCountByRef[EXTEND_PUBKEY] ?? 0, 1,
                `seed ${seed}: expected exactly one landed extend tx per op`);
        }
    });

    it('lying minority (1 of 5) does not advance anchor via consensus inputs', async () => {
        const seedRoot = path.join(workRoot, 'liar');
        fs.mkdirSync(seedRoot, { recursive: true });
        fs.mkdirSync(path.join(seedRoot, 'inbox'), { recursive: true });
        initLedger(seedRoot, {
            anchor: DEFAULT_ANCHOR,
            tenantSequence: DEFAULT_TENANT_SEQUENCE,
            tenantAddress: TENANT_ADDRESS,
        });
        const dirs = seedNodeDirs(seedRoot);
        const round = 0;
        const lcl = 200;
        writePinnedRound(seedRoot, round, {
            anchor: DEFAULT_ANCHOR,
            tenantAddress: TENANT_ADDRESS,
            tenantSequence: DEFAULT_TENANT_SEQUENCE,
        });
        for (const d of dirs)
            await runChild(seedRoot, d, 0, round, lcl, 'observe');
        const inboxDir = path.join(seedRoot, 'inbox');
        const messages = fs.readdirSync(inboxDir).map((f) => JSON.parse(fs.readFileSync(path.join(inboxDir, f), 'utf8')));
        const liar = messages[0];
        const parsed = JSON.parse(liar.payload);
        parsed.validatedIndex = DEFAULT_ANCHOR + 30;
        parsed.ledgerHash = 'LIAR_HASH';
        liar.payload = JSON.stringify(parsed);
        fs.writeFileSync(path.join(seedRoot, `consensus-inputs-r${round}.json`), JSON.stringify({ messages }));
        writePinnedRound(seedRoot, round, {
            anchor: DEFAULT_ANCHOR,
            tenantAddress: TENANT_ADDRESS,
            tenantSequence: DEFAULT_TENANT_SEQUENCE,
        });
        for (const d of dirs)
            await runChild(seedRoot, d, 0, round, lcl, 'exec');
        const anchorAfter = JSON.parse(fs.readFileSync(path.join(seedRoot, 'n0', 'operations.json'), 'utf8')).anchorLedger;
        assert.strictEqual(anchorAfter, DEFAULT_ANCHOR);
    });
});
