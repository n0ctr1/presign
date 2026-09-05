/**
 * Core vocabulary of the operational layer.
 *
 * The layer exists because subgraph discovery answers "what is this subgraph"
 * while a pre-signature verdict needs "which deployments can answer this rule
 * right now, and how far behind chain head are they". Those are different
 * questions, and only the second one can be allowed to gate a signature.
 */

/** EIP-155 chain id. */
export type ChainId = number;

/**
 * graph-node network identifier (`mainnet`, `arbitrum-one`, `matic`, `base`).
 * Deliberately distinct from {@link ChainId}: the registry corpus is keyed by
 * these strings, while RPC and calldata are keyed by the numeric id.
 */
export type NetworkId = string;

/** IPFS hash of a specific subgraph deployment (`Qm…`). Pinned, never floating. */
export type DeploymentId = string;

/** Identifier of a rule in the verdict engine. */
export type RuleId = "R1" | "R2" | "R3";

/**
 * Coarse grouping of deployments that expose a comparable data shape.
 * A family is what a rule binds to, so that adding a protocol is a
 * configuration change rather than a code change.
 */
export type SchemaFamily =
  | "lending-cdp"
  | "dex-amm"
  | "yield-vault"
  | "staking"
  | "perpetuals";

/**
 * A deployment as the discovery source describes it, before this layer has
 * verified anything. Nothing here is trusted for a verdict: `reliability` is an
 * economic score (query fees, volume, curation, indexer allocation), which
 * measures "popular and staked", not "indexing right now".
 */
export interface DeploymentCandidate {
  readonly deploymentId: DeploymentId;
  readonly subgraphId: string;
  readonly displayName: string;
  readonly network: NetworkId;
  readonly schemaFamily: SchemaFamily | null;
  /** Protocol slug as classified upstream, e.g. `aave-v3`. */
  readonly protocol: string | null;
  /** Contract addresses extracted from the deployment manifest, lowercased. */
  readonly contractAddresses: readonly string[];
  /** Economic score in [0, 1]. Informational only — never a freshness signal. */
  readonly reliability: number;
  /** Endpoint requiring a Subgraph Studio API key. */
  readonly queryUrl: string;
  /** Public x402 endpoint, paid per query. Null when the source exposes none. */
  readonly queryUrlX402: string | null;
}

/**
 * Result of asking a live deployment which fields it actually answers.
 *
 * Conformance is not a boolean and not a schema hash. An upstream fingerprint
 * (MD5 over `entity:field_count` pairs) detects that a schema changed and
 * groups forks; it cannot tell us whether this deployment will answer the
 * specific fields a rule reads. So we keep the field list.
 */
export interface ConformanceReport {
  readonly deploymentId: DeploymentId;
  /** Fields from the probed set that the deployment answered successfully. */
  readonly answersFields: readonly string[];
  /** Fields from the probed set that the deployment did not answer. */
  readonly missingFields: readonly string[];
  readonly checkedAt: Date;
}

/**
 * Result of measuring how far a deployment is behind chain head.
 *
 * `lagSeconds` is derived, not reported: graph-node exposes the indexed block
 * number, and the distance to head is only meaningful once compared against the
 * chain's own head timestamp.
 */
export interface LivenessReport {
  readonly deploymentId: DeploymentId;
  /** Latest block the deployment has indexed. */
  readonly indexedBlock: number;
  /** Timestamp of that block, as the chain recorded it. */
  readonly indexedBlockTimestamp: number;
  /** Chain head at the moment of the check. */
  readonly headBlock: number;
  /**
   * How far the indexer is behind the chain.
   *
   * Kept separate from {@link lagSeconds} because the two answer different
   * questions and can diverge. If the chain itself stalls, the data ages while
   * the indexer stays exactly at head: `lagSeconds` grows, `blocksBehind` stays
   * at zero. Collapsing them into one number means blaming the indexer for a
   * halted chain, or worse, treating stale data as fresh because the indexer is
   * technically caught up.
   */
  readonly blocksBehind: number;
  /**
   * Age of the newest indexed block in seconds, against wall clock.
   *
   * This is the number the freshness budget is enforced against: for a verdict
   * returned before a signature, what matters is how old the data is, not why.
   */
  readonly lagSeconds: number;
  /** graph-node's own error flag. A true value disqualifies the deployment. */
  readonly hasIndexingErrors: boolean;
  readonly checkedAt: Date;
}

/**
 * A candidate that has been probed. This is the record the capability index
 * stores and the record whose contents end up quoted in a verdict's provenance.
 */
export interface DeploymentRecord {
  readonly candidate: DeploymentCandidate;
  readonly conformance: ConformanceReport;
  readonly liveness: LivenessReport;
}

/**
 * A rule's data requirement, expressed against a schema family rather than a
 * protocol, so that one requirement covers every protocol in the family.
 */
export interface RuleRequirement {
  readonly ruleId: RuleId;
  readonly schemaFamily: SchemaFamily;
  /** Every one of these fields must be answered; a partial match is not usable. */
  readonly requiredFields: readonly string[];
  /** Freshness budget. A deployment lagging past this cannot serve the rule. */
  readonly maxLagSeconds: number;
}

/**
 * Why a rule could not be served. Returned instead of an empty list, because
 * "no deployment is fresh enough" and "no deployment exists" must lead to the
 * same fail-closed verdict but to different operator action.
 */
export type UnavailabilityReason =
  | "no_candidates"
  | "no_conforming_deployment"
  | "all_candidates_stale"
  | "all_candidates_erroring";

/**
 * The answer to "which deployments can answer this rule right now".
 *
 * A resolution is either satisfied with at least one record, or unsatisfied
 * with a reason. There is no third state: the verdict engine reads this
 * discriminant directly and fails closed on `satisfied: false`.
 */
export type CapabilityResolution =
  | {
      readonly satisfied: true;
      readonly ruleId: RuleId;
      /** Ordered best-first: lowest lag, then highest field coverage. */
      readonly records: readonly DeploymentRecord[];
    }
  | {
      readonly satisfied: false;
      readonly ruleId: RuleId;
      readonly reason: UnavailabilityReason;
      /** Candidates that were considered and rejected, for operator diagnosis. */
      readonly rejected: readonly DeploymentRecord[];
    };

/**
 * The discovery source, kept behind an interface on purpose.
 *
 * The Graph is required by the hackathon track but is a constraint for the
 * product: the Hosted Service is deprecated and the ecosystem is spreading
 * across Ormi, Goldsky, Envio and SubQuery. Keeping the source a parameter
 * means going indexer-agnostic is a new implementation of this interface, not
 * a rewrite of the layer.
 */
export interface DiscoverySource {
  readonly name: string;
  /** Candidates for a family, optionally narrowed to one network. */
  findCandidates(query: {
    readonly schemaFamily: SchemaFamily;
    readonly network?: NetworkId;
    readonly limit?: number;
  }): Promise<readonly DeploymentCandidate[]>;
  /** Candidates whose manifest names this contract. Used to identify a counterparty. */
  findByContract(
    address: string,
    network: NetworkId,
  ): Promise<readonly DeploymentCandidate[]>;
}

/**
 * Source of chain head, needed to turn an indexed block number into a lag.
 * Separate from {@link DiscoverySource} because the two fail independently:
 * losing RPC must not look like losing the indexer.
 */
export interface ChainHeadSource {
  headBlock(network: NetworkId): Promise<{ number: number; timestamp: number }>;
}
