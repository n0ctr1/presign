/**
 * Binds rules to the deployments that can currently serve them.
 *
 * This is the layer's public question. Not "what is this subgraph", but
 * "which deployments can answer R3 right now, under a 30-second lag budget".
 *
 * Probing happens ahead of time in {@link CapabilityIndex.warm}; resolution at
 * request time is a synchronous cache read. That split is not an optimisation,
 * it is the reason a verdict can fit inside a second: introspection, a probe
 * query and a chain-head lookup per candidate cannot happen while a signature
 * waits.
 */

import type {
  CapabilityResolution,
  ConformanceChecker,
  DeploymentCandidate,
  DeploymentRecord,
  DiscoverySource,
  LivenessChecker,
  NetworkId,
  RuleRequirement,
} from "../types.js";

interface CacheEntry {
  /** Every candidate that was successfully probed, conforming or not. */
  readonly records: readonly DeploymentRecord[];
  /** How many candidates discovery returned, before probing. */
  readonly candidateCount: number;
  readonly warmedAt: Date;
}

export interface CapabilityIndexOptions {
  readonly discovery: DiscoverySource;
  readonly conformance: ConformanceChecker;
  readonly liveness: LivenessChecker;
  /**
   * How many candidates to probe per rule.
   *
   * Kept low by default. Conformance costs two introspection queries plus a
   * probe per deployment and liveness costs one more per refresh, against a
   * Studio free tier of 100k queries a month — warming a few hundred
   * deployments on a short interval exhausts it in under a day.
   */
  readonly maxCandidates?: number;
  /** Concurrent probes during warm-up. */
  readonly concurrency?: number;
  /** Injectable so tests do not depend on wall clock. */
  readonly now?: () => Date;
}

const DEFAULT_MAX_CANDIDATES = 8;
const DEFAULT_CONCURRENCY = 4;

/**
 * Lag as it stands now, not as it stood when the probe ran.
 *
 * A record probed five minutes ago reporting five seconds of lag is not a
 * five-second-fresh record. The deployment may have kept up, but we have no
 * evidence that it did, so the age of the measurement is added to the measured
 * lag. Without this, a warm cache silently converts stale data into green
 * verdicts — precisely the failure this project exists to prevent, arriving
 * through our own cache rather than through the indexer.
 */
export function effectiveLagSeconds(record: DeploymentRecord, now: Date): number {
  const measurementAge = Math.max(
    0,
    (now.getTime() - record.liveness.checkedAt.getTime()) / 1000,
  );
  return record.liveness.lagSeconds + measurementAge;
}

/** Run tasks with a bounded number in flight, preserving input order. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<readonly R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from(
    { length: Math.min(Math.max(1, limit), items.length) },
    async () => {
      for (;;) {
        const index = cursor++;
        const item = items[index];
        if (item === undefined) return;
        results[index] = await task(item);
      }
    },
  );

  await Promise.all(workers);
  return results;
}

export class CapabilityIndex {
  readonly #discovery: DiscoverySource;
  readonly #conformance: ConformanceChecker;
  readonly #liveness: LivenessChecker;
  readonly #maxCandidates: number;
  readonly #concurrency: number;
  readonly #now: () => Date;
  readonly #cache = new Map<string, CacheEntry>();

  constructor(options: CapabilityIndexOptions) {
    this.#discovery = options.discovery;
    this.#conformance = options.conformance;
    this.#liveness = options.liveness;
    this.#maxCandidates = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
    this.#concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    this.#now = options.now ?? (() => new Date());
  }

  static cacheKey(ruleId: string, network: NetworkId): string {
    return `${ruleId}:${network}`;
  }

  /**
   * Discover and probe candidates for a rule, replacing anything cached.
   *
   * Never throws for an individual candidate: one deployment refusing
   * introspection must not deny the rule every other deployment that works.
   */
  async warm(
    requirement: RuleRequirement,
    network: NetworkId,
  ): Promise<CapabilityResolution> {
    const discovered = await this.#discovery.findCandidates({
      schemaFamily: requirement.schemaFamily,
      network,
      limit: this.#maxCandidates,
    });

    // Discovery may widen a network filter; a deployment indexing another chain
    // cannot answer for this transaction whatever its score.
    const candidates = discovered
      .filter((candidate) => candidate.network === network)
      .slice(0, this.#maxCandidates);

    const probed = await mapWithConcurrency(
      candidates,
      this.#concurrency,
      (candidate) => this.#probe(candidate, requirement, network),
    );

    const records = probed.filter(
      (record): record is DeploymentRecord => record !== null,
    );

    this.#cache.set(CapabilityIndex.cacheKey(requirement.ruleId, network), {
      records,
      candidateCount: candidates.length,
      warmedAt: this.#now(),
    });

    return this.resolve(requirement, network);
  }

  async #probe(
    candidate: DeploymentCandidate,
    requirement: RuleRequirement,
    network: NetworkId,
  ): Promise<DeploymentRecord | null> {
    try {
      const [conformance, liveness] = await Promise.all([
        this.#conformance.check(candidate.deploymentId, {
          rootField: requirement.rootField,
          fields: requirement.requiredFields,
        }),
        this.#liveness.check(candidate.deploymentId, network),
      ]);
      return { candidate, conformance, liveness };
    } catch {
      // A candidate that cannot be probed is a candidate we know nothing
      // about, which is not the same as a candidate we know is fine.
      return null;
    }
  }

  /**
   * Which deployments can serve this rule right now. Synchronous by design.
   *
   * Rejections are ordered from most to least fundamental so the reason names
   * the actual blocker: an operator told "all stale" acts differently from one
   * told "nothing conforms", and reporting the wrong one sends them to the
   * wrong system.
   */
  resolve(
    requirement: RuleRequirement,
    network: NetworkId,
  ): CapabilityResolution {
    const { ruleId } = requirement;
    const entry = this.#cache.get(CapabilityIndex.cacheKey(ruleId, network));

    if (entry === undefined) {
      return { satisfied: false, ruleId, reason: "not_warmed", rejected: [] };
    }
    if (entry.candidateCount === 0) {
      return { satisfied: false, ruleId, reason: "no_candidates", rejected: [] };
    }

    const conforming = entry.records.filter(
      (record) => record.conformance.missingFields.length === 0,
    );
    if (conforming.length === 0) {
      return {
        satisfied: false,
        ruleId,
        reason: "no_conforming_deployment",
        rejected: entry.records,
      };
    }

    const healthy = conforming.filter(
      (record) => !record.liveness.hasIndexingErrors,
    );
    if (healthy.length === 0) {
      return {
        satisfied: false,
        ruleId,
        reason: "all_candidates_erroring",
        rejected: conforming,
      };
    }

    const now = this.#now();
    const fresh = healthy.filter(
      (record) => effectiveLagSeconds(record, now) <= requirement.maxLagSeconds,
    );
    if (fresh.length === 0) {
      return {
        satisfied: false,
        ruleId,
        reason: "all_candidates_stale",
        rejected: healthy,
      };
    }

    // Freshest first, then widest field coverage. Reliability is never a
    // tiebreak: it is an economic score that tracks traction and therefore age,
    // and letting it order a freshness-gated list reintroduces exactly the bias
    // this layer exists to remove.
    const records = [...fresh].sort((a, b) => {
      const byLag = effectiveLagSeconds(a, now) - effectiveLagSeconds(b, now);
      if (byLag !== 0) return byLag;
      return b.conformance.answersFields.length - a.conformance.answersFields.length;
    });

    return { satisfied: true, ruleId, records };
  }

  /** When this rule was last warmed, for operator visibility. */
  warmedAt(ruleId: string, network: NetworkId): Date | null {
    return this.#cache.get(CapabilityIndex.cacheKey(ruleId, network))?.warmedAt ?? null;
  }
}
