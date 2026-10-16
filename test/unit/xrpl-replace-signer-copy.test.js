const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const XrplContext = require('../../dist/context/XrplContext').default;
const { createWorkDir } = require('./test-workdir');

describe('replaceSignerList deep copy (cache safety)', () => {
    let tmpDir;
    let originalCwd;

    beforeEach(() => {
        originalCwd = process.cwd();
        tmpDir = createWorkDir('evp-xrpl-signer-copy');
        process.chdir(tmpDir);
    });

    afterEach(() => {
        process.chdir(originalCwd);
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('does not mutate cached signerList before the ledger tx succeeds', async () => {
        const cached = {
            signerQuorum: 2,
            signerList: [
                { account: 'rOld', weight: 1 },
                { account: 'rKeep', weight: 1 },
            ],
        };
        const hpContext = { publicKey: 'self', contractId: 'c' };
        const voteContext = { getUniqueNumber: () => 1, vote: async () => [] };
        const xrplContext = new XrplContext({ hpContext, voteContext }, { network: 'testnet' });
        xrplContext.signerListInfo = {
            signerQuorum: cached.signerQuorum,
            signerList: cached.signerList.map((s) => ({ ...s })),
        };

        const snapshot = JSON.stringify(xrplContext.getSignerList());
        let duringTx = null;
        xrplContext.setSignerList = async (info) => {
            duringTx = JSON.stringify(xrplContext.getSignerList());
            xrplContext.signerListInfo = {
                signerQuorum: info.signerQuorum,
                signerList: info.signerList.map((s) => ({ ...s })),
            };
        };

        await xrplContext.replaceSignerList('rOld', 'rNew');
        assert.strictEqual(duringTx, snapshot);
        assert.notStrictEqual(JSON.stringify(xrplContext.getSignerList()), snapshot);
    });
});
