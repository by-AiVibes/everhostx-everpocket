'use strict';
// Public constructors, then init(), against a loopback rippled.
// An inert xahauLedger that reports validated index 0 makes getLedgerHashAt
// return before the xrplApi ledger read. A missing server must throw.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DIST, SRC } = require('./lib/env');
const { productionBackendSite } = require('./lib/sites');
const { startRippledStub, captureCommandSockets, bindMissingLedgerRequest, localDefinitions } = require('./lib/rippled-stub');

const TENANT_ADDRESS = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
const CLOSED_PORT = 'ws://127.0.0.1:1';

function contract() {
    return {
        publicKey: 'aa'.repeat(33),
        contractId: 'c',
        lclSeqNo: 10,
        lclHash: crypto.createHash('sha256').update('l').digest('hex'),
        timestamp: 1700000000000,
        privateKey: 'bb'.repeat(32),
    };
}

function loadContexts() {
    return require(path.join(DIST, 'index.js'));
}

function pinnedReadSite() {
    const rel = 'context/XrplContext.ts';
    const file = path.join(SRC, rel);
    if (!fs.existsSync(file))
        return productionBackendSite();
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const index = lines.findIndex((line) => line.includes('async getLedgerHashAt'));
    if (index >= 0)
        return `${rel}:${index + 1}`;
    return productionBackendSite();
}

test('init throws when no production backend is configured', async () => {
    const site = productionBackendSite();
    const restoreDefinitions = localDefinitions();
    const { XrplContext, HotPocketContext } = loadContexts();
    const previousCwd = process.cwd();
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-backend-'));
    try {
        process.chdir(workDir);
        const hp = new HotPocketContext(contract());
        const xrpl = new XrplContext(hp, TENANT_ADDRESS, null, {
            rippleServer: CLOSED_PORT,
            fallbackRippledServers: [CLOSED_PORT],
        });
        await assert.rejects(
            () => xrpl.init(),
            (error) => {
                assert.ok(error, `${site}: init must throw when no production backend is configured`);
                return true;
            }
        );
    }
    finally {
        restoreDefinitions();
        process.chdir(previousCwd);
        fs.rmSync(workDir, { recursive: true, force: true });
    }
});

test('public init reaches a loopback rippled for a pinned ledger read', async () => {
    const site = productionBackendSite();
    const readSite = pinnedReadSite();
    const restoreDefinitions = localDefinitions();
    const stub = await startRippledStub();
    const capture = captureCommandSockets();
    const { XrplContext, EvernodeContext, HotPocketContext } = loadContexts();
    const previousCwd = process.cwd();
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-backend-'));
    let xrpl;
    try {
        process.chdir(workDir);
        const hp = new HotPocketContext(contract());
        xrpl = new XrplContext(hp, TENANT_ADDRESS, null, {
            rippleServer: stub.url,
            fallbackRippledServers: [stub.url],
        });
        const evernode = new EvernodeContext(xrpl);
        assert.equal(evernode.xrplContext, xrpl, `${site}: EvernodeContext was not built on the public XrplContext`);
        await xrpl.init();
        assert.equal(typeof xrpl.getLedgerHashAt, 'function', `${site}: production getLedgerHashAt is missing from XrplContext`);
        assert.ok(
            bindMissingLedgerRequest(xrpl.xrplApi, capture.sockets),
            `${readSite}: init did not open a production rippled socket`
        );
        const pinnedIndex = stub.validatedLedger - 10;
        const hash = await xrpl.getLedgerHashAt(pinnedIndex);
        const pinnedReads = stub.requests.filter((message) => message.command === 'ledger' && message.ledger_index === pinnedIndex);
        assert.ok(
            pinnedReads.length > 0,
            `${readSite}: pinned ledger read did not reach the production rippled (${stub.requests.map((message) => `${message.command}:${message.ledger_index}`).join(',')})`
        );
        assert.equal(hash, stub.ledgerHash, `${readSite}: pinned ledger hash was not the rippled response (got ${hash})`);
    }
    finally {
        restoreDefinitions();
        capture.restore();
        if (xrpl && xrpl.xrplApi && xrpl.xrplApi.disconnect)
            await xrpl.xrplApi.disconnect().catch(() => {});
        if (xrpl && xrpl.deinit)
            await xrpl.deinit().catch(() => {});
        await stub.close();
        process.chdir(previousCwd);
        fs.rmSync(workDir, { recursive: true, force: true });
    }
});
