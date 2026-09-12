/**
 * Bridges the verdict engine to the operational layer.
 *
 * This is where the two halves of the project meet: layer 2 asks "is this
 * protocol's accounting sound", and layer 1 decides whether anyone can answer
 * that right now. Keeping the join in one small adapter means the rule never
 * touches a gateway or a registry directly, and the freshness gate cannot be
 * bypassed by a rule that decides it knows better.
 */

import type {
  ConformanceChecker,
  DeploymentCandidate,
  DeploymentRecord,
  DiscoverySource,
  GatewayClient,
  LivenessChecker,
  NetworkId,
  RuleRequirement,
} from "@presign/operational-layer";

import type { Address } from "../types.js";
import { LruMap } from "../util/lru-map.js";
import type { ProbeOutcome, ProtocolContext } from "../rules/r3-invariant-breach.js";

interface CachedProbe {
  readonly outcome: ProbeOutcome;
  readonly probedAt: Date;
}

interface CachedIndexing {
  readonly candidates: readonly DeploymentCandidate[];
  readonly foundAt: Date;
}

export interface OperationalProtocolContextOptions {
  readonly discovery: DiscoverySource;
  readonly conformance: ConformanceChecker;
  readonly liveness: LivenessChecker;
  readonly gateway: GatewayClient;
  /**
   * How long a probe result may be reused.
   *
   * Only a cost control, never a safety one: R3 compares the *effective* lag,
   * which already grows with the age of the measurement, so a cached probe
   * that has gone stale fails the budget rather than passing quietly. This
   * merely decides when to spend gateway quota refreshing it.
   */
  readonly probeTtlSeconds?: number;
  /**
   * Addresses and probes remembered at most. Callers choose the addresses,
   * so an unbounded memo is memory anyone can fill with free quote requests.
   */
  readonly maxCacheEntries?: number;
  readonly now?: () => Date;
}

export class OperationalProtocolContext implements ProtocolContext {
  readonly #discovery: DiscoverySource;
  readonly #conformance: ConformanceChecker;
  readonly #liveness: LivenessChecker;
  readonly #gateway: GatewayClient;
  readonly #probeTtlSeconds: number;
  readonly #now: () => Date;
  readonly #probes: LruMap<string, CachedProbe>;
  readonly #indexing: LruMap<string, CachedIndexing>;

  constructor(options: OperationalProtocolContextOptions) {
    this.#probes = new LruMap(options.maxCacheEntries ?? 2048);
    this.#indexing = new LruMap(options.maxCacheEntries ?? 2048);
    this.#discovery = options.discovery;
    this.#conformance = options.conformance;
    this.#liveness = options.liveness;
    this.#gateway = options.gateway;
    this.#probeTtlSeconds = options.probeTtlSeconds ?? 10;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Deployments whose manifest names this contract.
   *
   * Memoised on the same TTL as the probes, because two rules now ask this
   * question about the same counterparty in a single verdict: R3 to find a
   * protocol it can check, R4 to find out whether anyone has ever heard of the
   * address. Without the memo an R4 that costs nothing new in principle would
   * double the registry traffic of every verdict in practice.
   *
   * A TTL is safe here in a way it would not be for liveness. Lag is a
   * measurement that decays, which is why it is aged rather than cached; the
   * set of manifests naming an address changes only when somebody publishes a
   * subgraph, and seconds of staleness in that answer cannot turn a stale
   * verdict green.
   */
  async findIndexingDeployments(
    address: Address,
    network: NetworkId,
  ): Promise<readonly DeploymentCandidate[]> {
    const key = `${address.toLowerCase()}:${network}`;
    const cached = this.#indexing.get(key);
    if (
      cached !== undefined &&
      (this.#now().getTime() - cached.foundAt.getTime()) / 1000 <=
        this.#probeTtlSeconds
    ) {
      return cached.candidates;
    }

    const candidates = await this.#discovery.findByContract(address, network);
    this.#indexing.set(key, { candidates, foundAt: this.#now() });
    return candidates;
  }

  /**
   * Conformance and liveness for one deployment.
   *
   * Issued together, because a sequential pair would measure the schema and
   * the chain seconds apart.
   *
   * A probe that throws is reported as `failed` rather than propagating: one
   * deployment refusing introspection must not deny the rule every other
   * deployment that indexes the same contract. But it is emphatically not
   * reported as a deployment that did not conform — the caller has to be able
   * to tell "this one cannot answer" from "we could not ask", because only
   * the first is safe to read as an absence of findings.
   */
  async probeDeployment(
    candidate: DeploymentCandidate,
    requirement: RuleRequirement,
    network: NetworkId,
  ): Promise<ProbeOutcome> {
    const key = `${candidate.deploymentId}:${requirement.ruleId}:${requirement.schemaFamily}:${network}`;
    const cached = this.#probes.get(key);
    if (
      cached !== undefined &&
      (this.#now().getTime() - cached.probedAt.getTime()) / 1000 <=
        this.#probeTtlSeconds
    ) {
      return cached.outcome;
    }

    let outcome: ProbeOutcome;
    try {
      const [conformance, liveness] = await Promise.all([
        this.#conformance.check(candidate.deploymentId, {
          rootField: requirement.rootField,
          fields: requirement.requiredFields,
        }),
        this.#liveness.check(candidate.deploymentId, network),
      ]);
      outcome = { status: "probed", record: { candidate, conformance, liveness } };
    } catch (error) {
      // The reason travels with the failure. "Could not probe" without a cause
      // sends an operator looking at the indexer when the answer might be an
      // expired key, a refused payment, or a timeout of our own making.
      outcome = {
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
      };
    }

    /*
     * Only a completed probe is remembered.
     *
     * A failure is a fact about one attempt, not about the deployment. Cached,
     * a single gateway timeout decided every verdict for the next ten seconds
     * — which is how a wider freshness budget came back `unavailable` while a
     * narrower one answered from the same deployment moments earlier.
     */
    if (outcome.status === "probed") {
      this.#probes.set(key, { outcome, probedAt: this.#now() });
    }
    return outcome;
  }

  query<T>(deploymentId: string, query: string): Promise<T> {
    return this.#gateway.query<T>(deploymentId, query);
  }
}
