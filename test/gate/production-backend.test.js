'use strict';
// The public constructors are the production path. Object.create plus an
// injected xahauLedger hides a missing backend; this test does not inject one.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DIST } = require('./lib/env');
const { productionBackendSite } = require('./lib/sites');

const TENANT_ADDRESS = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';

test('public XrplContext and EvernodeContext init path wires a production Xahau backend', () => {
    const site = productionBackendSite();
    const { XrplContext, EvernodeContext, HotPocketContext } = require(path.join(DIST, 'index.js'));
    const previousCwd = process.cwd();
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-backend-'));
    try {
        process.chdir(workDir);
        const contract = {
            publicKey: 'aa'.repeat(33),
            contractId: 'c',
            lclSeqNo: 10,
            lclHash: crypto.createHash('sha256').update('l').digest('hex'),
            timestamp: 1700000000000,
            privateKey: 'bb'.repeat(32),
        };
        const hp = new HotPocketContext(contract);
        const xrpl = new XrplContext(hp, TENANT_ADDRESS, null, {});
        const evernode = new EvernodeContext(xrpl);
        assert.equal(evernode.xrplContext, xrpl, `${site}: EvernodeContext was not built on the public XrplContext`);
        assert.equal(typeof xrpl.getTxAt, 'function', `${site}: production getTxAt is missing from XrplContext`);
        assert.equal(
            typeof xrpl.xahauLedger,
            'object',
            `${site}: production Xahau backend is not wired on the public init path`
        );
        assert.ok(xrpl.xahauLedger, `${site}: production Xahau backend is not wired on the public init path`);
        assert.equal(
            typeof xrpl.xahauLedger.getTxAt,
            'function',
            `${site}: production Xahau backend has no getTxAt`
        );
    }
    finally {
        process.chdir(previousCwd);
        fs.rmSync(workDir, { recursive: true, force: true });
    }
});
