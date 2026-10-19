// Regression pin for PR #36 / fix 3. On 06ba9f5 this is a no-op: in-place collection.sort()
// already makes collection[0] the lexicographic winner; kept for clarity and upstream alignment.
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const { EvernodeContext } = require('../../dist');
const { createWorkDir } = require('./test-workdir');

describe('decideMessageKey regression pin (no-op vs 06ba9f5)', () => {
    let tmpDir;
    let originalCwd;

    beforeEach(() => {
        tmpDir = createWorkDir('evp-msgkey');
        originalCwd = process.cwd();
        process.chdir(tmpDir);
        fs.writeFileSync('acquires.json', JSON.stringify({ acquiredNodes: [], pendingAcquires: [] }));
    });

    afterEach(() => {
        process.chdir(originalCwd);
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns the lexicographically smallest vote key', async () => {
        const sortedFirst = 'a_vote_pubkey_should_win';
        const unsortedFirst = 'z_vote_pubkey_should_not_win';

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

        const evernodeContext = new EvernodeContext({ hpContext, voteContext });
        const chosen = await evernodeContext.decideMessageKey();

        assert.strictEqual(chosen, sortedFirst);
    });
});
