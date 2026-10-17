'use strict';
// Child that calls the real VoteContext.vote and then crashes.
// The vote is reported through the ops file before exit. The locked sim
// (lib/sim/node.js) only sends voteUsed on the clean process.send path.
const fs = require('fs');
const { VoteContext, AllVoteElector } = require(process.env.DIST);

const opsFile = process.argv[2];
const VOTE_TIMEOUT_MS = 50;

function emit(record) {
    fs.appendFileSync(opsFile, `${JSON.stringify(record)}\n`);
}

const contract = { unl: { send: async () => {} } };
const voteContext = new VoteContext(contract);
const elector = new AllVoteElector(1, VOTE_TIMEOUT_MS);
const originalVote = voteContext.vote.bind(voteContext);

voteContext.vote = (...args) => {
    emit({ k: 'vote' });
    const pending = originalVote(...args);
    process.exit(1);
    return pending;
};

voteContext.vote('gate-election', ['ballot'], elector);
