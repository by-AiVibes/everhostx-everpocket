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
            else if (phase === 'exec')
                resolve(JSON.parse(fs.readFileSync(path.join(workRoot, nodeDir, '.evp-round-result.json'), 'utf8')));
            else
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
    fs.writeFileSync(path.join(seedRoot, `consensus-inputs-r${round}.json`), JSON.stringify({ messages }));
}

describe('extend with flaky sequence reader', () => {
    let workRoot;
    let originalCwd;

    beforeEach(() => {
        originalCwd = process.cwd();
        workRoot = createWorkDir('evp-reader-fail');
    });

    afterEach(() => {
        process.chdir(originalCwd);
        fs.rmSync(workRoot, { recursive: true, force: true });
    });

    it('one node reader fails during extend: equal state hashes, one landed tx', async () => {
        const seedRoot = workRoot;
        fs.mkdirSync(path.join(seedRoot, 'inbox'), { recursive: true });
        initLedger(seedRoot, {
            anchor: DEFAULT_ANCHOR,
            tenantSequence: DEFAULT_TENANT_SEQUENCE,
            tenantAddress: TENANT_ADDRESS,
        });
        const dirs = seedNodeDirs(seedRoot);
        const seed = 7;
        const round = 0;
        const lcl = 300;
        const ledger = readLedger(seedRoot);
        ledger.globalValidatedIndex = DEFAULT_ANCHOR + 25;
        for (let i = 0; i < NODE_COUNT; i++)
            ledger.nodeValidated[`n${i}`] = ledger.globalValidatedIndex;
        writeLedger(seedRoot, ledger);
        writePinnedRound(seedRoot, round, {
            anchor: DEFAULT_ANCHOR,
            tenantAddress: TENANT_ADDRESS,
            tenantSequence: DEFAULT_TENANT_SEQUENCE,
        });
        for (const d of dirs)
            await runChild(seedRoot, d, seed, round, lcl, 'observe');
        mergePartialObservations(seedRoot, seed, round);
        const results = [];
        for (const d of dirs) {
            const extra = d === 'n2' ? { EVP_SEQ_READER_FAIL: '1' } : {};
            results.push(await runChild(seedRoot, d, seed, round, lcl, 'exec', extra));
        }
        const hashes = dirs
            .filter((_, i) => !results[i].aborted)
            .map((d) => stateSha256(path.join(seedRoot, d)));
        for (const h of hashes)
            assert.strictEqual(h, hashes[0]);
        mergeSubmitIntents(seedRoot, round);
        const ledgerAfter = readLedger(seedRoot);
        assert.strictEqual(ledgerAfter.landedCountByRef[EXTEND_PUBKEY] ?? 0, 1);
    });
});
