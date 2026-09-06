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
  CapabilityIndex,
  CapabilityResolution,
  DiscoverySource,
  GatewayClient,
  NetworkId,
  RuleRequirement,
  SchemaFamily,
} from "@presign/operational-layer";

import type { Address } from "../types.js";
import type { ProtocolContext } from "../rules/r3-invariant-breach.js";

export interface OperationalProtocolContextOptions {
  readonly discovery: DiscoverySource;
  readonly index: CapabilityIndex;
  readonly gateway: GatewayClient;
  /**
   * Re-warm when the cached probe is older than this.
   *
   * The capability index already ages cached measurements, so a stale entry
   * fails the budget rather than passing silently. This only decides when to
   * spend queries refreshing it, which is a cost question, not a safety one.
   */
  readonly rewarmAfterSeconds?: number;
  readonly now?: () => Date;
}

export class OperationalProtocolContext implements ProtocolContext {
  readonly #discovery: DiscoverySource;
  readonly #index: CapabilityIndex;
  readonly #gateway: GatewayClient;
  readonly #rewarmAfterSeconds: number;
  readonly #now: () => Date;

  constructor(options: OperationalProtocolContextOptions) {
    this.#discovery = options.discovery;
    this.#index = options.index;
    this.#gateway = options.gateway;
    this.#rewarmAfterSeconds = options.rewarmAfterSeconds ?? 15;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Which schema family indexes this contract.
   *
   * Candidates are ranked by the registry's economic score, which says nothing
   * about classification quality, so the first row with a family we recognise
   * wins rather than the first row overall — a highly-ranked but unclassified
   * subgraph should not shadow a correctly classified one behind it.
   */
  async identifyFamily(
    address: Address,
    network: NetworkId,
  ): Promise<SchemaFamily | null> {
    const candidates = await this.#discovery.findByContract(address, network);
    for (const candidate of candidates) {
      if (candidate.schemaFamily !== null) return candidate.schemaFamily;
    }
    return null;
  }

  async resolveCapability(
    requirement: RuleRequirement,
    network: NetworkId,
  ): Promise<CapabilityResolution> {
    const warmedAt = this.#index.warmedAt(
      requirement.ruleId,
      requirement.schemaFamily,
      network,
    );

    const ageSeconds =
      warmedAt === null
        ? Number.POSITIVE_INFINITY
        : (this.#now().getTime() - warmedAt.getTime()) / 1000;

    if (ageSeconds > this.#rewarmAfterSeconds) {
      return this.#index.warm(requirement, network);
    }
    return this.#index.resolve(requirement, network);
  }

  query<T>(deploymentId: string, query: string): Promise<T> {
    return this.#gateway.query<T>(deploymentId, query);
  }
}
