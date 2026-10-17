'use strict';
// Same multi-process round loop as lib/sim/run.js, plus the fields the
// locked runner does not return (agreed extend results) and a validated-ledger
// start so a pin can be born already expired.
const { fork } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { DIST } = require('./env');
const { landedPerOp } = require('./sim/run');

const NODE_IDS = ['A', 'B', 'C', 'D', 'E'];
const ANCHOR_LEDGER = 10000;
const HASH = (value) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 10);

function writeNodeHome(root, id, ops, nodes, operationState) {
    const dir = path.join(root, id);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'acquires.json'), JSON.stringify({ acquiredNodes: [], pendingAcquires: [] }));
    fs.writeFileSync(path.join(dir, 'cluster.json'), JSON.stringify({ initialized: true, nodes, pendingNodes: [] }));
    fs.writeFileSync(path.join(dir, 'operations.json'), JSON.stringify({
        operations: ops,
        ...(operationState || {}),
    }));
    fs.writeFileSync(path.join(dir, 'cfg.json'), JSON.stringify({
        unl: NODE_IDS,
        max_input_ledger_offset: 10,
        consensus: { roundtime: 1000, stage_slice: 100 },
        evernode: {
            feeCeiling: '5000',
            hosts: ['rH1', 'rH2', 'rH3'],
            anchorLedger: ANCHOR_LEDGER,
            tenantSequence: 5,
            checkpointInterval: 8,
            checkpointWindow: 3,
        },
    }));
    return dir;
}

function finish(res, id, value, ids, done) {
    if (res[id])
        return;
    res[id] = value;
    if (Object.keys(res).length === ids.length)
        done();
}

async function runRound(root, dirs, ledgerFile, ledger, round, options, ids) {
    const lcl = 500 + round * 4;
    const rng = options.rng || Math.random;
    ledger.lag = options.lag ? options.lag(round, ledger) : {};
    for (const id of ids) {
        if (ledger.lag[id] == null && options.jitter)
            ledger.lag[id] = ledger.validated - Math.floor(rng() * 12);
    }
    fs.writeFileSync(ledgerFile, JSON.stringify(ledger));
    fs.writeFileSync(`${ledgerFile}.ops`, '');
    const inputFile = path.join(root, `in-r${round}.json`);
    fs.writeFileSync(inputFile, JSON.stringify(options.inject ? options.inject(round, options._inputs) : options._inputs));
    const res = {};
    const kids = {};
    for (const id of ids) {
        const mode = (options.modes ? options.modes(id, round) : 'ok') || 'ok';
        kids[id] = fork(path.join(__dirname, 'sim', 'node.js'), [
            id,
            dirs[id],
            ids.join(','),
            mode,
            String(lcl),
            ledgerFile,
            inputFile,
            path.join(root, `out-${id}.json`),
        ], { env: { ...process.env, DIST } });
    }
    await new Promise((done) => {
        for (const id of ids) {
            kids[id].on('error', () => {
                finish(res, id, { aborted: true, err: 'fork error', voteUsed: false, f: ['', '', ''] }, ids, done);
            });
            kids[id].on('exit', () => {
                finish(res, id, { aborted: true, err: 'exit', voteUsed: false, f: ['', '', ''] }, ids, done);
            });
            kids[id].on('message', (message) => {
                if (message.done) {
                    finish(res, id, message, ids, done);
                    kids[id].kill();
                    return;
                }
                for (const to of ids) {
                    if (to !== message.from && kids[to].connected)
                        kids[to].send(message, () => {});
                }
            });
        }
    });
    for (const id of ids) {
        if (kids[id] && kids[id].exitCode === null)
            kids[id].kill('SIGKILL');
    }
    return res;
}

function absorbLedgerOps(ledgerFile, ledger, stat, seqs) {
    const raw = fs.readFileSync(`${ledgerFile}.ops`, 'utf8');
    for (const line of raw.split('\n').filter(Boolean)) {
        const event = JSON.parse(line);
        stat[event.k] = (stat[event.k] || 0) + 1;
        if (event.k !== 'tx')
            continue;
        const nextSeq = ledger.seq0 + Object.keys(ledger.txs).length;
        if (!ledger.txs[event.h] && event.lls >= ledger.validated + 1 && event.seq === nextSeq) {
            ledger.txs[event.h] = {
                ledger: ledger.validated + 1,
                rc: event.rc,
                lls: event.lls,
                seq: event.seq,
                fee: event.fee,
                ref: event.ref,
            };
            seqs.add(`${event.seq}@${event.lls}`);
        }
    }
}

async function scenExt(name, options) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-sim-'));
    const ids = NODE_IDS;
    const rounds = options.rounds || 20;
    const ledgerFile = path.join(root, 'ledger.json');
    const ledger = {
        validated: options.validatedStart || ANCHOR_LEDGER,
        lag: {},
        txs: {},
        seq0: 5,
        hash: {},
    };
    for (let index = 9000; index < 12000; index++)
        ledger.hash[index] = crypto.createHash('sha256').update(`ledger${index}`).digest('hex').toUpperCase();
    const dirs = {};
    for (const id of ids)
        dirs[id] = writeNodeHome(root, id, options.ops, options.nodes, options.operationState);
    let divergentRounds = 0;
    let first = null;
    let aborts = 0;
    let votesUsed = 0;
    const stat = {};
    const anchors = [];
    const seqs = new Set();
    const errs = {};
    options._inputs = [];
    try {
        for (let round = 0; round < rounds; round++) {
            const res = await runRound(root, dirs, ledgerFile, ledger, round, options, ids);
            absorbLedgerOps(ledgerFile, ledger, stat, seqs);
            ledger.validated += 4;
            const nextInputs = [];
            const rng = options.rng || Math.random;
            for (const id of ids) {
                const output = path.join(root, `out-${id}.json`);
                if (!fs.existsSync(output))
                    continue;
                const message = JSON.parse(fs.readFileSync(output, 'utf8'));
                fs.unlinkSync(output);
                if (!(options.drop && rng() < options.drop))
                    nextInputs.push(message);
            }
            options._inputs = nextInputs;
            for (const id of ids) {
                if (res[id].voteUsed)
                    votesUsed++;
                if (res[id].err)
                    errs[res[id].err.slice(0, 120)] = res[id].err.slice(0, 120);
            }
            const live = ids.filter((id) => !res[id].aborted);
            aborts += ids.length - live.length;
            const signature = (id) => res[id].f.map(HASH).join('/');
            const counts = {};
            for (const id of live)
                counts[signature(id)] = (counts[signature(id)] || 0) + 1;
            if (Object.keys(counts).length > 1) {
                divergentRounds++;
                if (!first) {
                    first = {
                        r: round,
                        d: ids.map((id) => `${id}${res[id].aborted ? '(ab)' : ''}=${signature(id)}`).join(' '),
                    };
                }
            }
            const majority = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
            const source = majority && live.find((id) => signature(id) === majority[0]);
            if (source) {
                anchors.push(JSON.parse(res[source].f[0]).anchorLedger);
                for (const id of ids) {
                    ['operations.json', 'cluster.json', 'acquires.json'].forEach((file, index) => {
                        fs.writeFileSync(path.join(dirs[id], file), res[source].f[index]);
                    });
                }
            }
        }
        const fin = JSON.parse(fs.readFileSync(path.join(dirs.A, 'operations.json'), 'utf8'));
        const out = {
            errs: [...new Set(Object.values(errs))],
            name,
            rounds,
            divergentRounds,
            aborts,
            votesUsed,
            landedTxs: Object.keys(ledger.txs).length,
            distinctSeqLls: [...seqs],
            events: stat,
            opsLeft: fin.operations.map((op) => `${op.type}:${op.ref}#${op.attempt}`),
            anchorFirst: anchors[0],
            anchorLast: anchors[anchors.length - 1],
            agreedSeq: fin.agreedTenantSequence,
            agreedExtendResults: fin.agreedExtendResults || {},
            first,
            initialOps: options.ops.map((op) => op.ref),
            landedRefs: Object.values(ledger.txs).map((tx) => tx.ref),
        };
        return out;
    }
    finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

module.exports = { scenExt, landedPerOp, ANCHOR_LEDGER, NODE_IDS };
