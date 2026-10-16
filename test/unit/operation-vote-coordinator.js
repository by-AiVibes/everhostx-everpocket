/**
 * Synchronizes NPL-style operation outcome votes across simulated UNL nodes in tests.
 */
class OperationVoteCoordinator {
    constructor(expectedNodes) {
        this.expectedNodes = expectedNodes;
        this.elections = new Map();
    }

    #getElection(electionName) {
        if (!this.elections.has(electionName)) {
            this.elections.set(electionName, { ballots: [] });
        }
        return this.elections.get(electionName);
    }

    createVoteContext(nodeId) {
        let unique = 0;
        const coordinator = this;
        return {
            getUniqueNumber: () => unique++,
            vote: async (electionName, cast) => {
                const election = coordinator.#getElection(electionName);
                election.ballots.push({ nodeId, data: cast[0] });
                while (election.ballots.length < coordinator.expectedNodes) {
                    await new Promise((resolve) => setImmediate(resolve));
                }
                return election.ballots.map((b) => ({ sender: b.nodeId, data: b.data }));
            },
        };
    }
}

module.exports = { OperationVoteCoordinator };
