'use strict';
// The multisign fake returns TransactionInfo {hash, lastLedgerSequence,
// resultCode}. extendSubmit must record that resultCode. Reading res.code
// stores "unknown" because TransactionInfo has no code field.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const evernode = require('evernode-js-client');
const { DIST } = require('./lib/env');
const { submitRecorderSite } = require('./lib/sites');

const TENANT_ADDRESS = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
const HOST_ADDRESS = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe';
const TOKEN_ID = 'TOK-C';
const TX_HASH = 'AB'.repeat(32);
const LAST_LEDGER = 10030;

test('extendSubmit records TransactionInfo.resultCode from the multisign result', { timeout: 60000 }, async () => {
    const site = submitRecorderSite();
    const EvernodeContext = require(path.join(DIST, 'context', 'EvernodeContext.js')).default;
    const originals = {
        connect: evernode.TenantClient.prototype.connect,
        disconnect: evernode.TenantClient.prototype.disconnect,
        prepare: evernode.TenantClient.prototype.prepareExtendLeaseTransaction,
        decode: evernode.UtilHelpers.decodeLeaseTokenUri,
    };
    const previousCwd = process.cwd();
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-submit-'));
    evernode.TenantClient.prototype.connect = async () => true;
    evernode.TenantClient.prototype.disconnect = async () => {};
    evernode.TenantClient.prototype.prepareExtendLeaseTransaction = async () => ({ TransactionType: 'URITokenBuy' });
    evernode.UtilHelpers.decodeLeaseTokenUri = () => ({ leaseAmount: 1 });
    const submitted = {
        hash: TX_HASH,
        lastLedgerSequence: LAST_LEDGER,
        resultCode: 'tesSUCCESS',
    };
    try {
        process.chdir(workDir);
        const ctx = new EvernodeContext({
            hpContext: { lclHash: 'ab'.repeat(32), lclSeqNo: 80, publicKey: 'edC' },
            voteContext: {},
            xrplApi: {},
            xrplAcc: {
                address: TENANT_ADDRESS,
                getURITokens: async () => [{ index: TOKEN_ID, URI: '00' }],
            },
            async multiSignAndSubmitTransaction() {
                return submitted;
            },
        });
        let returned = null;
        let thrown = null;
        try {
            returned = await ctx.extendSubmit(HOST_ADDRESS, 2, TOKEN_ID, {
                extendOpRef: 'C',
                txSubmitInfo: { sequence: 5, maxLedgerSequence: LAST_LEDGER, fee: '5000' },
            });
        }
        catch (error) {
            thrown = error;
        }
        assert.equal(thrown, null, `${site}: extendSubmit threw before recording TransactionInfo: ${thrown}`);
        assert.equal(returned && returned.resultCode, 'tesSUCCESS', `${site}: extendSubmit did not return TransactionInfo.resultCode`);
        const recorded = ctx.observationPendingSubmits;
        assert.ok(
            Array.isArray(recorded) && recorded.length === 1,
            `${site}: extendSubmit did not record the multisign TransactionInfo (got ${JSON.stringify(recorded)})`
        );
        assert.equal(recorded[0].hash, TX_HASH, `${site}: recorded hash ${recorded[0].hash}`);
        assert.equal(
            recorded[0].resultCode,
            'tesSUCCESS',
            `${site}: submit recorder stored '${recorded[0].resultCode}' from res.code instead of TransactionInfo.resultCode tesSUCCESS`
        );
    }
    finally {
        evernode.TenantClient.prototype.connect = originals.connect;
        evernode.TenantClient.prototype.disconnect = originals.disconnect;
        evernode.TenantClient.prototype.prepareExtendLeaseTransaction = originals.prepare;
        evernode.UtilHelpers.decodeLeaseTokenUri = originals.decode;
        process.chdir(previousCwd);
        fs.rmSync(workDir, { recursive: true, force: true });
    }
});
