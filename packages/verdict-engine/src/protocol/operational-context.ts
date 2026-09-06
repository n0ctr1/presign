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
import type { ProtocolContext } from "../rules/r3-invariant-breach.js";

interface CachedProbe {
  readonly record: DeploymentRecord | null;
  readonly probedAt: Date;
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
  readonly now?: () => Date;
}

export class OperationalProtocolContext implements ProtocolContext {
  readonly #discovery: DiscoverySource;
  readonly #conformance: ConformanceChecker;
  readonly #liveness: LivenessChecker;
  readonly #gateway: GatewayClient;
  readonly #probeTtlSeconds: number;
  readonly #now: () => Date;
  readonly #probes = new Map<string, CachedProbe>();

  constructor(options: OperationalProtocolContextOptions) {
    this.#discovery = options.discovery;
    this.#conformance = options.conformance;
    this.#liveness = options.liveness;
    this.#gateway = options.gateway;
    this.#probeTtlSeconds = options.probeTtlSeconds ?? 10;
    this.#now = options.now ?? (() => new Date());
  }

  findIndexingDeployments(
    address: Address,
    network: NetworkId,
  ): Promise<readonly DeploymentCandidate[]> {
    return this.#discovery.findByContract(address, network);
  }

  /**
   * Conformance and liveness for one deployment.
   *
   * Issued together, because a sequential pair would measure the schema and
   * the chain seconds apart. A probe that throws yields null rather than
   * propagating: one deployment refusing introspection must not deny the rule
   * every other deployment that indexes the same contract.
   */
  async probeDeployment(
    candidate: DeploymentCandidate,
    requirement: RuleRequirement,
    network: NetworkId,
  ): Promise<DeploymentRecord | null> {
    const key = `${candidate.deploymentId}:${requirement.ruleId}:${requirement.schemaFamily}:${network}`;
    const cached = this.#probes.get(key);
    if (
      cached !== undefined &&
      (this.#now().getTime() - cached.probedAt.getTime()) / 1000 <=
        this.#probeTtlSeconds
    ) {
      return cached.record;
    }

    let record: DeploymentRecord | null;
    try {
      const [conformance, liveness] = await Promise.all([
        this.#conformance.check(candidate.deploymentId, {
          rootField: requirement.rootField,
          fields: requirement.requiredFields,
        }),
        this.#liveness.check(candidate.deploymentId, network),
      ]);
      record = { candidate, conformance, liveness };
    } catch {
      record = null;
    }

    this.#probes.set(key, { record, probedAt: this.#now() });
    return record;
  }

  query<T>(deploymentId: string, query: string): Promise<T> {
    return this.#gateway.query<T>(deploymentId, query);
  }
}
