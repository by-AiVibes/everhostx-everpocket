import { Buffer } from 'buffer';
import { VoteContext, XrplContext } from ".";
import { AcquireData, AcquireOptions, AcquiredNode, Instance, LeaseURIInfo, PendingAcquire } from "../models/evernode";
import * as evernode from 'evernode-js-client';
import { createHash, randomBytes } from 'crypto';
import { AllVoteElector } from "../vote/vote-electors";
import { URIToken } from "../models";
import * as fs from 'fs';
import * as kp from 'ripple-keypairs';
import { JSONHelpers } from "../utils";
import { VoteElectorOptions } from "../models/vote";
import HotPocketContext from "./HotPocketContext";
import { error, log } from "../helpers/logger";
import NumberHelpers from "../utils/helpers/NumberHelper";

const TIMEOUT = 10000;
const ACQUIRE_ABANDON_LCL_THRESHOLD = 10;
const ACQUIRE_IV_LENGTH = 16;
const ACQUIRE_KEY_LENGTH = 32;
const ACQUIRE_CONTRIBUTION_LENGTH = 32;
const ACQUIRE_SCALAR_ATTEMPTS = 8;
// Domain separators keep the IV and the ephemeral key independent of each other.
const ACQUIRE_IV_DOMAIN = Buffer.from('everpocket-acquire-iv-v1');
const ACQUIRE_KEY_DOMAIN = Buffer.from('everpocket-acquire-ephemeral-v1');
const SECP256K1_ORDER = Buffer.from('fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141', 'hex');

class EvernodeContext {
    private acquireDataFile: string = "acquires.json";
    private acquireData: AcquireData = { acquiredNodes: [], pendingAcquires: [] };
    private registryClient: any;
    private updatedData: boolean = false;
    private initialized: boolean = false;
    // Holds the acquire IV, ephemeral key, and this node's contribution until submit, then wiped.
    private acquireKeyScratch: { iv: Buffer; ephemPrivateKey: Buffer; contribution: Buffer | null } | null = null;
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
        // Get transaction details to use for xrpl tx submission.
        const tenantClient = new evernode.TenantClient(this.xrplContext.xrplAcc.address);
        await tenantClient.connect();

        try {
            // lclHash is public consensus data, so it cannot seed the cipher.
            // The NPL/UNL vote channel is plaintext JSON, so the IV and key are not
            // sent on it either. Each node contributes CSPRNG bytes. Every node
            // sorts those contributions and hashes them into one IV and one key.
            const timeout = this.#acquireVoteTimeout(options);
            const material = await this.#agreeAcquireKeyMaterial(timeout);
            this.#assertAcquireKeyMaterial(material.iv, material.ephemPrivateKey);
            this.acquireKeyScratch = material;
            const preparedAcquireTxn = await tenantClient.prepareAcquireLeaseTransaction(hostAddress, { ...(JSONHelpers.castFromModel(options.instanceCfg)), messageKey: messageKey }, { leaseOfferIndex: leaseOffer.index, iv: material.iv, ephemPrivateKey: material.ephemPrivateKey });
            await this.#rejectMismatchedAcquireMemo(preparedAcquireTxn, timeout);
            return await this.xrplContext.multiSignAndSubmitTransaction(preparedAcquireTxn, options);
        } finally {
            this.#wipeAcquireKeyScratch();
            await tenantClient.disconnect();
        }
    }

    /**
     * Vote timeout carried on the same options object multisign already reads.
     */
    #acquireVoteTimeout(options: AcquireOptions): number {
        const requested = (options as AcquireOptions & { voteElectorOptions?: VoteElectorOptions }).voteElectorOptions?.timeout;
        return requested || TIMEOUT;
    }

    /**
     * UNL members that will build this acquire, or an empty list when this
     * process has no vote channel (a single signer builds the transaction alone).
     */
    #acquireUnl(): { publicKey: string }[] {
        const getter = this.hpContext && this.hpContext.getContractUnl;
        if (typeof getter !== 'function')
            return [];
        const listed = getter.call(this.hpContext);
        return Array.isArray(listed) ? listed : [];
    }

    #isSecp256k1Scalar(key: Buffer): boolean {
        return key.length === ACQUIRE_KEY_LENGTH
            && key.compare(Buffer.alloc(ACQUIRE_KEY_LENGTH)) > 0
            && key.compare(SECP256K1_ORDER) < 0;
    }

    #randomSecp256k1Scalar(): Buffer {
        let key = randomBytes(ACQUIRE_KEY_LENGTH);
        for (let attempt = 1; attempt <= ACQUIRE_SCALAR_ATTEMPTS && !this.#isSecp256k1Scalar(key); attempt++)
            key = randomBytes(ACQUIRE_KEY_LENGTH);
        return key;
    }

    /**
     * Agree an IV and ephemeral key.
     * With two or more voting nodes, hash the sorted contributions.
     * Alone, draw both values from the CSPRNG. Callers must wipe the buffers.
     */
    async #agreeAcquireKeyMaterial(timeout: number): Promise<{ iv: Buffer; ephemPrivateKey: Buffer; contribution: Buffer | null }> {
        const unl = this.#acquireUnl();
        if (unl.length < 2 || typeof this.voteContext?.vote !== 'function') {
            return {
                iv: randomBytes(ACQUIRE_IV_LENGTH),
                ephemPrivateKey: this.#randomSecp256k1Scalar(),
                contribution: null
            };
        }

        const contribution = randomBytes(ACQUIRE_CONTRIBUTION_LENGTH);
        const electionName = `acquire_key_contribution${this.voteContext.getUniqueNumber()}`;
        const votes = await this.voteContext.vote(electionName, [contribution.toString('hex')], new AllVoteElector(unl.length, timeout));
        if (!Array.isArray(votes) || votes.length !== unl.length)
            throw new Error('acquire key agreement did not collect a contribution from every node');

        const parts: Buffer[] = [];
        for (const vote of votes) {
            const part = Buffer.from(String(vote.data), 'hex');
            if (part.length !== ACQUIRE_CONTRIBUTION_LENGTH)
                throw new Error('acquire key contribution must be 32 bytes');
            parts.push(part);
        }
        // Arrival order differs per node. Sort so every node hashes the same bytes.
        parts.sort((left, right) => Buffer.compare(left, right));
        const derived = this.#deriveAcquireKeyMaterial(parts);
        for (const part of parts)
            part.fill(0);
        return { iv: derived.iv, ephemPrivateKey: derived.ephemPrivateKey, contribution };
    }

    /**
     * IV and key are separate hashes so neither is a slice or encoding of the other.
     */
    #deriveAcquireKeyMaterial(sortedContributions: Buffer[]): { iv: Buffer; ephemPrivateKey: Buffer } {
        const joined = Buffer.concat(sortedContributions);
        const ivHash = createHash('sha256').update(ACQUIRE_IV_DOMAIN).update(joined).digest();
        const iv = Buffer.from(ivHash.subarray(0, ACQUIRE_IV_LENGTH));
        ivHash.fill(0);

        let ephemPrivateKey = createHash('sha256').update(ACQUIRE_KEY_DOMAIN).update(joined).digest();
        for (let attempt = 1; attempt <= ACQUIRE_SCALAR_ATTEMPTS && !this.#isSecp256k1Scalar(ephemPrivateKey); attempt++)
            ephemPrivateKey = createHash('sha256').update(ACQUIRE_KEY_DOMAIN).update(joined).update(Buffer.from([attempt])).digest();
        const keyCopy = Buffer.from(ephemPrivateKey);
        ephemPrivateKey.fill(0);
        joined.fill(0);
        return { iv, ephemPrivateKey: keyCopy };
    }

    #assertAcquireKeyMaterial(iv: Buffer, ephemPrivateKey: Buffer): void {
        if (iv.length !== ACQUIRE_IV_LENGTH)
            throw new Error(`acquire IV must be ${ACQUIRE_IV_LENGTH} bytes`);
        if (!this.#isSecp256k1Scalar(ephemPrivateKey))
            throw new Error(`acquire ephemeral key must be a ${ACQUIRE_KEY_LENGTH}-byte secp256k1 scalar`);
    }

    /**
     * Every node encrypts locally. Abort before multisign unless every memo matches.
     */
    async #rejectMismatchedAcquireMemo(transaction: any, timeout: number): Promise<void> {
        const unl = this.#acquireUnl();
        if (unl.length < 2 || typeof this.voteContext?.vote !== 'function')
            return;
        if (!Array.isArray(transaction?.Memos) || transaction.Memos.length === 0)
            throw new Error('acquire transaction is missing its memo');

        const memo = Buffer.from(JSON.stringify(transaction.Memos));
        const electionName = `acquire_memo${this.voteContext.getUniqueNumber()}`;
        const votes = await this.voteContext.vote(electionName, [memo.toString('hex')], new AllVoteElector(unl.length, timeout));
        if (!Array.isArray(votes) || votes.length !== unl.length)
            throw new Error('acquire memo agreement did not collect a memo from every node');

        const expected = memo.toString('hex');
        for (const vote of votes) {
            if (vote.data !== expected)
                throw new Error('acquire memo mismatch');
        }
    }

    #wipeAcquireKeyScratch(): void {
        const scratch = this.acquireKeyScratch;
        if (!scratch)
            return;
        // Zero the private key first so its bytes are still intact if the IV aliases them.
        scratch.ephemPrivateKey.fill(0);
        scratch.iv.fill(0);
        if (scratch.contribution)
            scratch.contribution.fill(0);
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