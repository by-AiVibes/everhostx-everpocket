import { VoteContext, XrplContext } from ".";
import { AcquireData, AcquireOptions, AcquiredNode, Instance, LeaseURIInfo, PendingAcquire } from "../models/evernode";
import * as evernode from 'evernode-js-client';
import { Buffer } from 'buffer';
import { AllVoteElector } from "../vote/vote-electors";
import { URIToken } from "../models";
import * as fs from 'fs';
import * as kp from 'ripple-keypairs';
import { derivePrivateKey } from 'ripple-keypairs/dist/secp256k1';
import { JSONHelpers } from "../utils";
import { VoteElectorOptions } from "../models/vote";
import HotPocketContext from "./HotPocketContext";
import { error, log } from "../helpers/logger";
import NumberHelpers from "../utils/helpers/NumberHelper";

const nodeCrypto = require('crypto');
const tinySecp256k1 = require('tiny-secp256k1');

const TIMEOUT = 10000;
const ACQUIRE_ABANDON_LCL_THRESHOLD = 10;
const ACQUIRE_IV_LENGTH = 16;
const ACQUIRE_KEY_LENGTH = 32;
const ACQUIRE_CONTRIBUTION_LENGTH = 32;
const ACQUIRE_IV_DOMAIN = Buffer.from('everpocket-acquire-iv-v1');
const ACQUIRE_KEY_DOMAIN = Buffer.from('everpocket-acquire-ephemeral-v2');
const ACQUIRE_UNL_KEY = /^ed[0-9a-f]{64}$/i;

interface AcquireKeyScratch {
    iv: Buffer;
    ephemPrivateKey: Buffer;
    contribution: Buffer;
    parts: Buffer[];
    joined: Buffer | null;
    seed: Buffer | null;
    ivHash: Buffer | null;
}

/**
 * Acquire elections wait for one vote from every UNL sender, or for the deadline.
 * They never treat N messages as a quorum. Other elections keep AllVoteElector.
 */
class AcquireUnlVoteElector extends AllVoteElector {
    private unlKeys: Set<string>;

    public constructor(publicKeys: string[], timeout: number) {
        super(publicKeys.length, timeout);
        this.unlKeys = new Set(publicKeys.map((publicKey: string) => publicKey.toLowerCase()));
    }

    public election(electionName: string, voteEmitter: any, context: VoteContext): Promise<any[]> {
        return new Promise((resolve) => {
            let settled = false;
            let scheduled = false;
            let latest: any[] = [];
            const finish = () => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(deadline);
                resolve(context.resolveVotes(electionName));
            };
            const deadline = setTimeout(finish, this.timeout);
            const consider = () => {
                const seen = new Map<string, number>();
                for (const vote of latest) {
                    const raw = vote && vote.sender && vote.sender.publicKey;
                    const publicKey = raw ? String(raw).toLowerCase() : '';
                    if (!publicKey || !this.unlKeys.has(publicKey))
                        continue;
                    seen.set(publicKey, (seen.get(publicKey) || 0) + 1);
                }
                const doubled = Array.from(seen.values()).some(count => count > 1);
                if (doubled || seen.size === this.unlKeys.size)
                    finish();
            };
            voteEmitter.on(electionName, (collected: any[]) => {
                latest = Array.isArray(collected) ? collected : [];
                if (settled || scheduled)
                    return;
                scheduled = true;
                // NPL delivery is synchronous. Decide after this turn so one batch
                // is not cut off at the first N messages.
                setTimeout(() => {
                    scheduled = false;
                    if (!settled)
                        consider();
                }, 0);
            });
        });
    }
}

class EvernodeContext {
    private acquireDataFile: string = "acquires.json";
    private acquireData: AcquireData = { acquiredNodes: [], pendingAcquires: [] };
    private registryClient: any;
    private updatedData: boolean = false;
    private initialized: boolean = false;
    // Exact buffers the cipher used. finally zeroes them; there is no getter.
    private acquireKeyScratch: AcquireKeyScratch | null = null;
    // One acquireSubmit at a time on this instance. A second call rejects immediately.
    private acquireInFlight: boolean = false;
    public hpContext: HotPocketContext;
    public xrplContext: XrplContext;
    public voteContext: VoteContext;

    public constructor(xrplContext: XrplContext) {
        this.xrplContext = xrplContext;
        this.hpContext = this.xrplContext.hpContext;
        this.voteContext = this.xrplContext.voteContext;

        evernode.Defaults.set({
            xrplApi: xrplContext.xrplApi
        });

        const data = JSONHelpers.readFromFile<AcquireData>(this.acquireDataFile);
        if (data)
            this.acquireData = data;
        else
            JSONHelpers.writeToFile(this.acquireDataFile, this.acquireData);
    }

    /**
     * Initialize the context.
     */
    public async init(): Promise<void> {
        if (this.initialized)
            return;

        await this.xrplContext.init();

        try {
            this.registryClient = await evernode.HookClientFactory.create(evernode.HookTypes.registry);
            await this.registryClient.connect();

            await this.#checkForCompletedAcquires();
            this.initialized = true;
        } catch (e) {
            await this.deinit();
            throw e;
        }
    }

    /**
     * Deinitialize the context.
     */
    public async deinit(): Promise<void> {
        this.#persistAcquireData();
        if (this.registryClient)
            await this.registryClient.disconnect();
        await this.xrplContext.deinit();
        this.initialized = false;
    }

    /**
     * Persist details of acquires.
     */
    #persistAcquireData(): void {
        if (!this.updatedData)
            return;

        try {
            JSONHelpers.writeToFile(this.acquireDataFile, this.acquireData);
        } catch (error) {
            throw `Error writing file ${this.acquireDataFile}: ${error}`;
        }
    }

    /**
     * Updates the detail file with inserts and deletes of
     * pending acquires
     * @param element Element to be added or removed
     * @param mode Type of operation ("INSERT" or "DELETE")
     */
    #updatePendingAcquireInfo(element: PendingAcquire, mode: string = "INSERT"): void {
        if (mode === "INSERT")
            this.acquireData.pendingAcquires.push(element); // modify the array as needed
        else {
            // Find the index of the record to remove
            const indexToRemove = this.acquireData.pendingAcquires.findIndex((record: { leaseOfferIdx: string; }) => record.leaseOfferIdx === element.leaseOfferIdx);

            // Check if the record exists in the array, and remove it if found
            if (indexToRemove !== -1) {
                this.acquireData.pendingAcquires.splice(indexToRemove, 1);
            }
        }
        this.updatedData = true;
    }

    /**
     * Updates the detail file with inserts and deletes of
     * successful acquires
     * @param element Element to be added or removed
     * @param mode Type of operation ("INSERT" or "DELETE")
     */
    #updateAcquiredNodeInfo(element: AcquiredNode, mode: string = "INSERT"): void {
        if (mode === "INSERT")
            this.acquireData.acquiredNodes.push(element); // modify the array as needed
        else {
            // Find the index of the record to remove
            const indexToRemove = this.acquireData.acquiredNodes.findIndex((record: { name: string; }) => record.name === element.name);

            // Check if the record exists in the array, and remove it if found
            if (indexToRemove !== -1) {
                this.acquireData.acquiredNodes.splice(indexToRemove, 1);
            }
        }
        this.updatedData = true;
    }

    /**
     * Check whether there're any completed pending acquires.
     * @param [options={}] Vote options for payload sharing.
     */
    async #checkForCompletedAcquires(options: VoteElectorOptions = {}): Promise<void> {
        // Check for pending transactions and their completion.
        for (const item of this.getPendingAcquires()) {
            // Check if transaction is validated. If not skip.
            const validated = this.xrplContext.getValidatedTransaction(item.refId);
            if (!validated)
                continue;

            const privateKey = fs.existsSync(`../${item.messageKey}.txt`) ?
                fs.readFileSync(`../${item.messageKey}.txt`, { encoding: 'utf8', flag: 'r' }) : null;

            let remove = false;
            // Remove transaction if failed.
            if (validated.resultCode !== "tesSUCCESS") {
                log(`Transaction failed for ${item.refId} with code: ${validated.resultCode}.`);
                remove = true;
            }
            // Remove if no ledger index.
            else if (!validated.ledgerIndex) {
                log(`No ledger index for the transaction ${item.refId}.`);
                remove = true;
            }
            // Abandon waiting for this node if threshold reached.
            else if (item.acquireSentOnLcl < (this.hpContext.lclSeqNo - ACQUIRE_ABANDON_LCL_THRESHOLD)) {
                log(`Maximum acquire wait threshold reached, Abandoning waiting for ${item.refId}.`);
                remove = true;
            }

            if (remove) {
                this.#updatePendingAcquireInfo(item, "DELETE");
                if (privateKey)
                    fs.unlinkSync(`../${item.messageKey}.txt`);
                continue;
            }

            const txList = await this.xrplContext.getTransactions(validated.ledgerIndex!);

            for (let t of txList) {
                t.tx.Memos = evernode.TransactionHelper.deserializeMemos(t.tx?.Memos);
                t.tx.HookParameters = evernode.TransactionHelper.deserializeHookParams(t.tx?.HookParameters);

                const tenantClient = new evernode.TenantClient(this.xrplContext.xrplAcc.address, null, { messagePrivateKey: privateKey });
                const res = await tenantClient.extractEvernodeEvent(t.tx);
                let payload = null;
                if (res?.name === evernode.TenantEvents.AcquireSuccess && res?.data?.acquireRefId === item.refId)
                    payload = res.data.payload;
                else if (res?.name === evernode.TenantEvents.AcquireError && res?.data?.acquireRefId === item.refId)
                    payload = 'acquire_error';

                if (payload) {
                    const electionName = `share_payload${this.voteContext.getUniqueNumber()}`;
                    const elector = new AllVoteElector(1, options?.timeout || TIMEOUT);
                    payload = (privateKey ? await this.voteContext.vote(electionName, [payload], elector) : await this.voteContext.subscribe(electionName, elector)).map(ob => ob.data)[0];

                    // Updated the acquires if there's a success response.
                    if (payload) {
                        if (payload !== 'acquire_error') {
                            // Assign ip to domain and outbound_ip for instance created from old sashimono version.
                            if ('ip' in payload.content) {
                                payload.content.domain = payload.content.ip;
                                delete payload.content.ip;
                            }
                            this.#updateAcquiredNodeInfo({ host: item.host, refId: item.refId, ...JSONHelpers.castToModel<Instance>(payload.content) });
                        }
                        this.#updatePendingAcquireInfo(item, "DELETE");
                        if (privateKey)
                            fs.unlinkSync(`../${item.messageKey}.txt`);
                    }
                }
            }

        }
    }

    /**
     * Acquires a node based on the provided options.
     * @param options Options related to a particular acquire operation.
     * @returns Acquire data.
     */
    public async acquireNode(options: AcquireOptions = {}): Promise<PendingAcquire> {
        // Use provided host or select a host randomly.
        const hostAddress = options.host || await this.decideHost(options.preferredHosts);
        // Choose the lease offer
        const leaseOffer = await this.decideLeaseOffer(hostAddress);

        const messageKey = await this.decideMessageKey();

        if (!leaseOffer || !messageKey)
            throw "Could not decide acquire params.";

        // Perform acquire txn on the selected host.
        const res = await this.acquireSubmit(hostAddress, leaseOffer, messageKey, options);

        const pendingAcquire = <PendingAcquire>{
            host: hostAddress,
            leaseOfferIdx: leaseOffer.index,
            refId: res.hash,
            messageKey: messageKey,
            acquireSentOnLcl: this.hpContext.lclSeqNo
        };

        // Record as a acquire transaction.
        this.#updatePendingAcquireInfo(pendingAcquire);

        return pendingAcquire;
    }

    /**
     * Get the acquire info if acquired.
     * @param acquireRefId Acquire reference.
     * @returns Acquired node.
     */
    public getIfAcquired(acquireRefId: string): AcquiredNode | null {
        const node = this.acquireData.acquiredNodes.find(n => n.refId == acquireRefId);
        return node ? node : null;
    }

    /**
     * Get the acquire info if pending.
     * @param acquireRefId Acquire reference.
     * @returns Pending node.
     */
    public getIfPending(acquireRefId: string): PendingAcquire | null {
        const node = this.acquireData.pendingAcquires.find(n => n.refId == acquireRefId);
        return node ? node : null;
    }

    /**
     * Decides a lease offer collectively.
     * @param hostAddress Host that should be used to take lease offers.
     * @returns URIToken related to the lease offer.
     */
    public async decideLeaseOffer(hostAddress: string): Promise<URIToken> {
        // Get transaction details to use for xrpl tx submission.
        const hostClient = new evernode.HostClient(hostAddress);
        const leaseOffers = await hostClient.getLeaseOffers();
        const leaseOffer = leaseOffers && leaseOffers.length > 0 && leaseOffers.sort((a: any, b: any) => a.index.localeCompare(b.index))[0];

        if (!leaseOffer)
            throw "NO_LEASE_OFFER";

        return leaseOffer;
    }

    /**
     * Decides a host collectively.
     * @param [preferredHosts=null] List of proffered host addresses.
     * @returns Decided host address.
     */
    public async decideHost(preferredHosts: string[] | null = null): Promise<string> {
        // Choose from hosts that have available instances.
        const vacantHosts = await this.getHosts();
        const unusedHosts = preferredHosts ? preferredHosts.filter(a => vacantHosts.find(h => a === h.address)) : vacantHosts.map(h => h.address);

        let hostAddress = null;
        if (unusedHosts.length > 0) {
            const randomIndex = NumberHelpers.getRandomNumber(this.hpContext, 0, unusedHosts.length);
            hostAddress = unusedHosts.sort((a: any, b: any) => a.localeCompare(b))[randomIndex];
        }
        else
            throw 'There are no vacant hosts in the network';

        return hostAddress;
    }

    /**
     * Decide a encryption key pair collectively
     * @param [options={}] Vote options for message key decision.
     * @returns Public key of the decided key pair.
     */
    public async decideMessageKey(options: VoteElectorOptions = {}): Promise<string> {
        const seed = kp.generateSeed();
        const keyPair: Record<string, any> = kp.deriveKeypair(seed);

        const electionName = `message_key_selection${this.voteContext.getUniqueNumber()}`;
        const voteRound = this.voteContext.vote(electionName, [keyPair.publicKey], new AllVoteElector(this.hpContext.getContractUnl().length, options?.timeout || TIMEOUT));
        let collection = (await voteRound).map((v) => v.data);

        let sortCollection = collection.sort((a, b) => a.localeCompare(b));

        if (sortCollection[0] === keyPair.publicKey) {
            fs.writeFileSync(`../${keyPair.publicKey}.txt`, keyPair.privateKey);
            log("Wrote Key file.");
        }

        return collection[0];
    }

    /**
     * Get evernode configuration.
     * @returns The evernode configuration.
     */
    public getEvernodeConfig() {
        return this.registryClient.config;
    }

    /**
     * Get the current evernode moment.
     * @param [options={}] Vote options to collect the current moment value.
     * @returns The current moment value
     */
    public async getCurMoment(options: VoteElectorOptions = {}) {
        // Vote for node created moment.
        const electionName = `share_node_create_moment${this.voteContext.getUniqueNumber()}`;
        const elector = new AllVoteElector(this.hpContext.getContractUnl().length, options?.timeout || TIMEOUT);
        const moment = await this.registryClient.getMoment();
        const nodes: number[] = (await this.voteContext.vote(electionName, [moment], elector)).map(ob => ob.data).sort();
        return nodes[0];
    }

    /**
     * Submits the acquire transaction
     * @param hostAddress Relevant host address
     * @param leaseOffer Relevant URIToken of the lease offer
     * @param messageKey Encryption key of the tenant.
     * @param options
     * @returns Result of the submitted transaction.
     */
    public async acquireSubmit(hostAddress: string, leaseOffer: URIToken, messageKey: string, options: AcquireOptions = {}): Promise<any> {
        if (this.acquireInFlight)
            throw new Error('acquire already in progress');
        this.acquireInFlight = true;
        // Get transaction details to use for xrpl tx submission.
        const tenantClient = new evernode.TenantClient(this.xrplContext.xrplAcc.address);
        try {
        await tenantClient.connect();

        // lclHash is public consensus data, so it cannot seed the cipher.
        // Peer links are hpws TLS 1.2+ with a self-signed per-node cert
        // (hpws.c SSL_CTX_set_min_proto_version TLS1_2; hpcore comm_server.hpp:261;
        // peer_comm_server.cpp:174; conf.cpp:202-250). The JSON vote bytes are the
        // local contract-to-hpcore pipe and the payload encoding, not the wire.
        // Passive outsiders cannot read the contributions. An active MITM is not
        // ruled out: there is no SSL_set_verify, and the peer-challenge binding at
        // p2p.cpp:88-100 is unconfirmed. Every UNL node and its host operator can
        // recompute the key and IV and decrypt the memo. In NPL mode "public",
        // non-UNL peers also receive the contributions (peer_comm_session.cpp:90-93,
        // sc.cpp:759); private is the default (conf.cpp:177). The memo holds the
        // owner pubkey, contract id, image, config, and the tenant messageKey.
        // There is no commit-reveal: the last sender can bias its own contribution
        // but cannot choose the key. Below ceil(2n/3) live nodes, no acquire lands.
        // This is strictly better than the public, deterministic lclHash.
        // Hex contribution votes cannot be wiped and may remain in
        // VoteContext.voteCollection until that election is resolved.
        const preparedAcquireTxn = await this.#prepareAgreedAcquire(tenantClient, hostAddress, leaseOffer, messageKey, options);
        await tenantClient.disconnect();

        return await this.xrplContext.multiSignAndSubmitTransaction(preparedAcquireTxn, options);
        } finally {
            this.acquireInFlight = false;
        }
    }

    /**
     * Agree an IV and ephemeral key from UNL contributions, then the memo.
     * The scratch buffers are wiped on the way out, including when this throws.
     */
    async #prepareAgreedAcquire(tenantClient: any, hostAddress: string, leaseOffer: URIToken, messageKey: string, options: AcquireOptions): Promise<any> {
        try {
            const unl = this.#requireAcquireUnl();
            const timeout = this.#acquireVoteTimeout(options);
            const contributors = await this.#agreeAcquireContributions(unl, timeout);
            const scratch = this.acquireKeyScratch;
            if (!scratch)
                throw new Error('acquire key scratch is missing');
            const cipherOptions = {
                leaseOfferIndex: leaseOffer.index,
                iv: scratch.iv,
                ephemPrivateKey: scratch.ephemPrivateKey
            };
            this.#assertAcquireCipherMaterial(cipherOptions.iv, cipherOptions.ephemPrivateKey);
            this.#assertAcquireEphemeralKey(cipherOptions.ephemPrivateKey);
            const preparedAcquireTxn = await tenantClient.prepareAcquireLeaseTransaction(hostAddress, { ...(JSONHelpers.castFromModel(options.instanceCfg)), messageKey: messageKey }, cipherOptions);
            await this.#agreeAcquireMemo(preparedAcquireTxn, contributors, unl, timeout);
            return preparedAcquireTxn;
        } finally {
            this.#wipeAcquireKeyScratch();
        }
    }

    #acquireVoteTimeout(options: AcquireOptions): number {
        const requested = options.voteElectorOptions?.timeout;
        return requested || TIMEOUT;
    }

    /**
     * The acquire node set is the contract UNL. Anything else fails closed.
     */
    #requireAcquireUnl(): { publicKey: string }[] {
        const listed = this.hpContext.getContractUnl();
        if (!Array.isArray(listed) || listed.length < 1)
            throw new Error('acquire consensus unavailable');
        const seen = new Set<string>();
        for (const node of listed) {
            const publicKey = node && node.publicKey;
            if (typeof publicKey !== 'string' || !ACQUIRE_UNL_KEY.test(publicKey))
                throw new Error('acquire consensus unavailable');
            const identity = publicKey.toLowerCase();
            for (const existing of seen) {
                if (existing.toLowerCase() === identity)
                    throw new Error('acquire consensus unavailable');
            }
            seen.add(publicKey);
        }
        const selfKey = this.hpContext.publicKey.toLowerCase();
        let selfFound = false;
        for (const existing of seen) {
            if (existing.toLowerCase() === selfKey)
                selfFound = true;
        }
        if (!selfFound)
            throw new Error('acquire consensus unavailable');
        return listed;
    }

    #acquireThreshold(unlSize: number): number {
        return Math.ceil((2 * unlSize) / 3);
    }

    async #agreeAcquireContributions(unl: { publicKey: string }[], timeout: number): Promise<string[]> {
        const contribution = nodeCrypto.randomBytes(ACQUIRE_CONTRIBUTION_LENGTH);
        this.acquireKeyScratch = {
            iv: Buffer.alloc(ACQUIRE_IV_LENGTH),
            ephemPrivateKey: Buffer.alloc(ACQUIRE_KEY_LENGTH),
            contribution,
            parts: [],
            joined: null,
            seed: null,
            ivHash: null
        };
        const electionName = `acquire_key_contribution${this.voteContext.getUniqueNumber()}`;
        const votes = await this.voteContext.vote(electionName, [contribution.toString('hex')], new AcquireUnlVoteElector(unl.map(node => node.publicKey), timeout));
        const accepted = this.#takeAcquireVotes(votes, unl);
        if (accepted.length < this.#acquireThreshold(unl.length))
            throw new Error('acquire key agreement below threshold');

        const parts: Buffer[] = [];
        const contributors: string[] = [];
        for (const vote of accepted) {
            const part = Buffer.from(String(vote.data), 'hex');
            parts.push(part);
            this.acquireKeyScratch.parts = parts;
            if (part.length !== ACQUIRE_CONTRIBUTION_LENGTH)
                throw new Error('acquire key contribution must be 32 bytes');
            contributors.push(vote.publicKey);
        }
        const derived = this.#deriveAcquireMaterial(parts);
        this.acquireKeyScratch.iv = derived.iv;
        this.acquireKeyScratch.ephemPrivateKey = derived.ephemPrivateKey;
        this.acquireKeyScratch.joined = derived.joined;
        this.acquireKeyScratch.seed = derived.seed;
        this.acquireKeyScratch.ivHash = derived.ivHash;
        return contributors;
    }

    /**
     * One vote per UNL sender, sorted by public key. A second vote aborts.
     * Senders outside the UNL, including a missing sender, are ignored and logged.
     */
    #takeAcquireVotes(votes: any[], unl: { publicKey: string }[]): { publicKey: string; data: any }[] {
        const allowed = new Set(unl.map(node => node.publicKey.toLowerCase()));
        const bySender = new Map<string, any>();
        for (const vote of (Array.isArray(votes) ? votes : [])) {
            const raw = vote && vote.sender && vote.sender.publicKey;
            const publicKey = raw ? String(raw).toLowerCase() : '';
            if (!publicKey || !allowed.has(publicKey)) {
                log(`acquire vote ignored from non-unl sender ${raw || 'unknown'}`);
                continue;
            }
            if (bySender.has(publicKey))
                throw new Error('acquire vote rejected: double vote');
            bySender.set(publicKey, vote.data);
        }
        return Array.from(bySender.keys()).sort().map(publicKey => ({ publicKey, data: bySender.get(publicKey) }));
    }

    /**
     * IV and key are domain-separated. The scalar step belongs to ripple-keypairs.
     */
    #deriveAcquireMaterial(parts: Buffer[]): { iv: Buffer; ephemPrivateKey: Buffer; joined: Buffer; seed: Buffer; ivHash: Buffer } {
        const joined = Buffer.concat(parts);
        const ivHash = nodeCrypto.createHash('sha256').update(ACQUIRE_IV_DOMAIN).update(joined).digest();
        const iv = Buffer.from(ivHash.subarray(0, ACQUIRE_IV_LENGTH));
        const seed = Buffer.concat([ACQUIRE_KEY_DOMAIN, joined]);
        const ephemPrivateKey = derivePrivateKey(seed, { validator: true }).toArrayLike(Buffer, 'be', ACQUIRE_KEY_LENGTH);
        return { iv, ephemPrivateKey, joined, seed, ivHash };
    }

    /**
     * Reject a scalar the curve library would refuse. eccrypto retries a supplied
     * key forever, so this runs on the exact buffer about to be encrypted.
     */
    #assertAcquireEphemeralKey(ephemPrivateKey: Buffer): void {
        if (!tinySecp256k1.isPrivate(ephemPrivateKey))
            throw new Error('acquire ephemeral key is not a valid secp256k1 private key');
    }

    #assertAcquireCipherMaterial(iv: Buffer | undefined, ephemPrivateKey: Buffer | undefined): void {
        if (!Buffer.isBuffer(iv) || iv.length !== ACQUIRE_IV_LENGTH)
            throw new Error('acquire IV must be 16 bytes');
        if (!Buffer.isBuffer(ephemPrivateKey) || ephemPrivateKey.length !== ACQUIRE_KEY_LENGTH)
            throw new Error('acquire ephemeral key must be 32 bytes');
    }

    /**
     * Multisign only when ceil(2n/3) UNL senders vote this memo and contributor set.
     */
    async #agreeAcquireMemo(transaction: any, contributors: string[], unl: { publicKey: string }[], timeout: number): Promise<void> {
        if (!Array.isArray(transaction?.Memos) || transaction.Memos.length === 0)
            throw new Error('acquire transaction is missing its memo');
        const payload = JSON.stringify({
            memo: Buffer.from(JSON.stringify(transaction.Memos)).toString('hex'),
            contributors
        });
        const electionName = `acquire_memo${this.voteContext.getUniqueNumber()}`;
        const votes = await this.voteContext.vote(electionName, [payload], new AcquireUnlVoteElector(unl.map(node => node.publicKey), timeout));
        const accepted = this.#takeAcquireVotes(votes, unl);
        let matched = 0;
        for (const vote of accepted) {
            if (vote.data === payload)
                matched += 1;
        }
        if (matched < this.#acquireThreshold(unl.length))
            throw new Error('acquire memo agreement below threshold');
    }

    #wipeAcquireKeyScratch(): void {
        const scratch = this.acquireKeyScratch;
        if (!scratch)
            return;
        scratch.ephemPrivateKey.fill(0);
        scratch.iv.fill(0);
        scratch.contribution.fill(0);
        for (const part of scratch.parts)
            part.fill(0);
        if (scratch.joined)
            scratch.joined.fill(0);
        if (scratch.seed)
            scratch.seed.fill(0);
        if (scratch.ivHash)
            scratch.ivHash.fill(0);
    }

    /**
     * This function is called by a tenant client to submit the extend lease transaction in certain host. This function will be called directly in test. This function can take four parameters as follows.
     * @param {string} hostAddress XRPL account address of the host.
     * @param {number} extension Moments to extend.
     * @param {string} tokenID Tenant received instance name. this name can be retrieve by performing acquire Lease.
     * @param {object} options This is an optional field and contains necessary details for the transactions.
     * @returns The transaction result.
     */
    public async extendSubmit(hostAddress: string, extension: number, tokenID: string, options: any = {}): Promise<any> {
        const leaseToken = (await this.xrplContext.xrplAcc.getURITokens()).find((t: any) => t.index === tokenID);
        if (!leaseToken)
            throw 'No lease token for given token id';

        const uriInfo = this.decodeLeaseTokenUri(leaseToken.URI);
        const tenantClient = new evernode.TenantClient(this.xrplContext.xrplAcc.address);
        await tenantClient.connect();

        const preparedAcquireTxn = await tenantClient.prepareExtendLeaseTransaction(hostAddress, ((uriInfo.leaseAmount * extension)).toString(), tokenID, options)
        await tenantClient.disconnect();

        return await this.xrplContext.multiSignAndSubmitTransaction(preparedAcquireTxn, options);
    }

    /**
     * Fetches registered hosts
     * @returns An array of hosts that are having vacant leases.
     */
    public async getHosts(): Promise<any[]> {
        const allHosts = await this.registryClient.getActiveHostsFromLedger();
        return allHosts.filter((h: { maxInstances: number; activeInstances: number; }) => (h.maxInstances - h.activeInstances) > 0);
    }

    /**
     * Fetches details of successful acquires.
     * @returns an array of instance acquisitions that are completed.
     */
    public getAcquiredNodes(): AcquiredNode[] {
        return this.acquireData.acquiredNodes;
    }

    /**
     * Fetches details of pending acquires.
     * @returns an array of instance acquisitions that are in progress.
     */
    public getPendingAcquires(): PendingAcquire[] {
        return this.acquireData.pendingAcquires;
    }

    /**
     * Decode the URI of the lease URIToken
     * @param uri URI of the URIToken
     * @returns decoded content of the URI
     */
    public decodeLeaseTokenUri(uri: string): LeaseURIInfo {
        return evernode.UtilHelpers.decodeLeaseTokenUri(uri);
    }
}

export default EvernodeContext;