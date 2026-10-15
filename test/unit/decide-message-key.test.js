const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { EvernodeContext } = require('../../dist');

describe('Fix 3: decideMessageKey returns lexicographically first vote', () => {
    let tmpDir;
    let originalCwd;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evp-msgkey-'));
        originalCwd = process.cwd();
        process.chdir(tmpDir);
        fs.writeFileSync('acquires.json', JSON.stringify({ acquiredNodes: [], pendingAcquires: [] }));
    });

    afterEach(() => {
        process.chdir(originalCwd);
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns sortCollection[0] (canonical vote), not the first collected vote datum', async () => {
        const unsortedFirst = 'z_vote_pubkey_should_not_win';
        const sortedFirst = 'a_vote_pubkey_should_win';

        const voteContext = {
            getUniqueNumber: () => 1,
            vote: async () => [
                { data: unsortedFirst },
                { data: sortedFirst },
            ],
        };

        const hpContext = {
            getContractUnl: () => [{ publicKey: 'n1' }, { publicKey: 'n2' }, { publicKey: 'n3' }],
            publicKey: 'self',
        };

        const xrplContext = { hpContext, voteContext };
        const evernodeContext = new EvernodeContext(xrplContext);

        const voteResults = [
            { data: unsortedFirst },
            { data: sortedFirst },
        ];

        const chosen = await evernodeContext.decideMessageKey();
        const firstCollected = voteResults.map((v) => v.data)[0];
        const canonical = [...voteResults.map((v) => v.data)].sort((a, b) => a.localeCompare(b))[0];

        assert.strictEqual(chosen, canonical);
        assert.strictEqual(chosen, sortedFirst);
        assert.notStrictEqual(firstCollected, canonical);
        assert.notStrictEqual(chosen, firstCollected);

        const brokenNonMutatingReturn = (results) => {
            const collection = results.map((v) => v.data);
            const sortCollection = [...collection].sort((a, b) => a.localeCompare(b));
            return collection[0];
        };
        assert.strictEqual(brokenNonMutatingReturn(voteResults), firstCollected);
        assert.notStrictEqual(brokenNonMutatingReturn(voteResults), canonical);
        assert.notStrictEqual(chosen, brokenNonMutatingReturn(voteResults));
    });
});
