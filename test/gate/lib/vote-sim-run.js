'use strict';
// Short multi-process round using vote-sim-node.js so a vote is on disk
// even when the round process exits.
const { fork } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { DIST } = require('./env');
const { EXT, NODES } = require('./sim/run');

const NODE_FILE = path.join(__dirname, 'vote-sim-node.js');
const NODE_IDS = ['A', 'B', 'C', 'D', 'E'];
const ANCHOR = 10000;

function readVotes(dir) {
    const file = path.join(dir, 'votes.log');
    if (!fs.existsSync(file))
        return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

async function runVoteSim(options) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-vote-sim-'));
    const rounds = options.rounds || 2;
    const ledgerFile = path.join(root, 'ledger.json');
    const ledger = { validated: ANCHOR, lag: {}, txs: {}, seq0: 5, hash: {} };
    for (let index = 9000; index < 12000; index++)
        ledger.hash[index] = crypto.createHash('sha256').update(`ledger${index}`).digest('hex').toUpperCase();
    const dirs = {};
    for (const id of NODE_IDS) {
        const dir = path.join(root, id);
        fs.mkdirSync(dir);
        dirs[id] = dir;
        fs.writeFileSync(path.join(dir, 'acquires.json'), JSON.stringify({ acquiredNodes: [], pendingAcquires: [] }));
        fs.writeFileSync(path.join(dir, 'cluster.json'), JSON.stringify({ initialized: true, nodes: NODES, pendingNodes: [] }));
        fs.writeFileSync(path.join(dir, 'operations.json'), JSON.stringify({ operations: options.ops || [EXT('C')] }));
        fs.writeFileSync(path.join(dir, 'cfg.json'), JSON.stringify({
            unl: NODE_IDS,
            max_input_ledger_offset: 10,
            consensus: { roundtime: 1000, stage_slice: 100 },
            evernode: {
                feeCeiling: '5000',
                hosts: ['rH1', 'rH2', 'rH3'],
                anchorLedger: ANCHOR,
                tenantSequence: 5,
                checkpointInterval: 8,
                checkpointWindow: 3,
            },
        }));
    }
    const votes = [];
    try {
        let inputs = [];
        for (let round = 0; round < rounds; round++) {
            fs.writeFileSync(ledgerFile, JSON.stringify(ledger));
            fs.writeFileSync(`${ledgerFile}.ops`, '');
            const inputFile = path.join(root, `in-${round}.json`);
            fs.writeFileSync(inputFile, JSON.stringify(inputs));
            const kids = {};
            const res = {};
            for (const id of NODE_IDS) {
                const mode = options.modes ? options.modes(id, round) : 'ok';
                kids[id] = fork(NODE_FILE, [
                    id,
                    dirs[id],
                    NODE_IDS.join(','),
                    mode || 'ok',
                    String(500 + round * 4),
                    ledgerFile,
                    inputFile,
                    path.join(root, `out-${id}.json`),
                ], { env: { ...process.env, DIST } });
            }
            await new Promise((done) => {
                for (const id of NODE_IDS) {
                    const finish = () => {
                        if (res[id])
                            return;
                        res[id] = true;
                        if (Object.keys(res).length === NODE_IDS.length)
                            done();
                    };
                    kids[id].on('exit', finish);
                    kids[id].on('error', finish);
                    kids[id].on('message', (message) => {
                        if (message.done) {
                            kids[id].kill();
                            finish();
                            return;
                        }
                        for (const to of NODE_IDS) {
                            if (to !== message.from && kids[to].connected)
                                kids[to].send(message, () => {});
                        }
                    });
                }
            });
            for (const id of NODE_IDS) {
                if (kids[id].exitCode === null)
                    kids[id].kill('SIGKILL');
            }
            inputs = [];
            ledger.validated += 4;
        }
        for (const id of NODE_IDS)
            votes.push(...readVotes(dirs[id]));
        return {
            votes: votes.length,
            a215: votes.filter((row) => row.election === 'a2-15').length,
        };
    }
    finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

module.exports = { runVoteSim };
