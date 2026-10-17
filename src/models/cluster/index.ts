import { AcquireOptions, AcquiredNode, PendingAcquire } from "../evernode";

export interface NodeStatusInfo {
  status: NodeStatus;
  onLcl: number;
}

export interface NodeInfo {
  status: NodeStatusInfo;
  acknowledgeTries: number;
}

export interface ClusterOptions {
  maturityLclThreshold?: number;
  acknowledgeLclThreshold?: number;
  acknowledgeRetryLclThreshold?: number;
}

export interface ClusterNode extends AcquiredNode {
  status: NodeStatusInfo;
  activeOnLcl?: number;
  isUnl: boolean;
  signerAddress?: string;
  createdOnTimestamp?: number;
  lifeMoments: number;
  targetLifeMoments: number;
  maxLifeMoments?: number;
  signerReplaceFailedAttempts?: number;
  owner: number;
}

export interface PendingNode extends PendingAcquire {
  targetLifeMoments: number;
  maxLifeMoments?: number;
  aliveCheckCount: number;
}

export interface ClusterData {
  initialized: boolean,
  nodes: ClusterNode[],
  pendingNodes: PendingNode[]
}

export interface ClusterMessage {
  type: ClusterMessageType;
  data?: any;
}

export interface ClusterMessageResponse {
  type: ClusterMessageType;
  status: ClusterMessageResponseStatus;
  data?: any;
}

export interface AddNodeOperation {
  acquireOptions: AcquireOptions;
  lifeMoments: number;
  maxLifeMoments?: number
}

export interface ExtendNodeOperation {
  nodePubkey: string;
  moments: number;
  extendTxHash?: string;
  extendLedgerCap?: number;
}

export interface RemoveNodeOperation {
  nodePubkey: string;
  force: boolean;
  signerTxCap?: number;
}

export interface Operation {
  type: OperationType,
  ref: string,
  data: AddNodeOperation | ExtendNodeOperation | RemoveNodeOperation,
  attempt?: number;
  nextAttemptLcl?: number;
  createdLcl?: number;
  /** Set when quorum shows the pinned sequence consumed by a different tx. */
  extendHoldReason?: string;
  /** Quorum-agreed submit identity already counted toward attempt (hash|lls|rc). */
  quorumCountedSubmitKey?: string;
  /** @deprecated migrated to attempt */
  retryCount?: number;
  /** @deprecated migrated to nextAttemptLcl */
  nextRetryLcl?: number;
}

export interface OperationData {
  operations: Operation[];
  /** Agreed Xahau ledger anchor; advances via consensus observation quorum (see docs/queue-agreed-state.md). */
  anchorLedger?: number;
  /** True when quorum agrees on validated index but not ledger hash (e.g. hash liar). */
  anchorQuorumStalled?: boolean;
  /** Quorum-agreed tenant sequence from observations (consumption when anchor quorum is stalled). */
  observedTenantSequenceQuorum?: number;
  agreedLedgerHash?: string;
  agreedTenantSequence?: number;
  agreedSignerListHash?: string;
  agreedExtendResults?: Record<string, { hash: string; lastLedgerSequence: number; resultCode: string }>;
  nodeUserRegistrations?: Record<string, string>;
  observationDedup?: Record<string, {
    nonce: number;
    observedLcl: number;
    extendSubmitVote?: {
      opRef: string;
      hash: string;
      lastLedgerSequence: number;
      resultCode: string;
    };
  }>;
  /** Tenant sequences for which a quorum-confirmed extend already landed; never resubmit at these. */
  consumedTenantSequences?: number[];
  /** Agreed extend tx fields pinned on first attempt (hash stable across retries). */
  pinnedExtendTxs?: Record<string, {
    tenantAddress: string;
    sequence: number;
    lastLedgerSequence: number;
    fee: string;
    host: string;
    anchorLedger: number;
    nodePubkey: string;
    moments: number;
    tokenId: string;
  }>;
}

export enum ClusterMessageType {
  MATURED = "maturity_ack",
  CLUSTER_NODES = "cluster_nodes",
  UNKNOWN = "unknown"
}

export enum ClusterMessageResponseStatus {
  OK = "ok",
  FAIL = "fail",
  UNHANDLED = "unhandled"
}

export enum OperationType {
  ADD_NODE = "add_node",
  EXTEND_NODE = "extend_node",
  REMOVE_NODE = "remove_node"
}

export enum NodeStatus {
  NONE = 0,
  CREATED,
  CONFIGURED,
  ACKNOWLEDGED,
  ADDED_TO_UNL
}

export enum ClusterOwner {
  NONE = 0,
  SELF_MANAGER
}
