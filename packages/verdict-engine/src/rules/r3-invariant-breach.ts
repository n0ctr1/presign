/**
 * R3 — the counterparty protocol's own accounting does not add up.
 *
 * This is the only rule that needs indexed protocol data, and that makes it
 * the rule where fail-closed matters. R1 reads the state diff, R2 reads
 * storage slots; both work with nothing but an RPC. If R3 could quietly
 * degrade to "nothing found" when its data is stale, indexed data would be
 * decorative and every green verdict would be suspect. So R3 returns
 * `unavailable` rather than an empty result whenever fresh context cannot be
 * obtained, and the type system makes that impossible to overlook.
 *
 * The checks are deliberately restricted to states that are *impossible*
 * rather than merely unusual. A protocol lending out more than was deposited,
 * or reporting locked value with no underlying balance, is broken accounting
 * under any market condition. Threshold-style checks — utilisation above some
 * percentage, TVL dropping by some amount — would fire on ordinary volatility,
 * and a scanner that flags healthy protocols is worse than one with narrow
 * coverage.
 */

import {
  R3_DEX,
  R3_LENDING,
  R3_VAULT,
  effectiveLagSeconds,
  type CapabilityResolution,
  type NetworkId,
  type RuleRequirement,
  type SchemaFamily,
} from "@presign/operational-layer";

import { evaluated } from "../types.js";
import type { Address, Finding, Rule, RuleContext, RuleOutcome } from "../types.js";

/** EIP-155 chain id to the graph-node network name the corpus is keyed by. */
export const CHAIN_TO_NETWORK: Readonly<Record<number, NetworkId>> = {
  1: "mainnet",
  10: "optimism",
  137: "matic",
  8453: "base",
  42161: "arbitrum-one",
};

interface Breach {
  readonly check: string;
  readonly entityId: string;
  readonly entityName: string;
  readonly detail: string;
  readonly values: Readonly<Record<string, string>>;
}

interface InvariantSpec {
  readonly requirement: RuleRequirement;
  /** Fields fetched for the check, a superset of the conformance-gated set. */
  readonly fields: readonly string[];
  check(entity: Readonly<Record<string, unknown>>): readonly Breach[];
}

const num = (entity: Readonly<Record<string, unknown>>, key: string): number | null => {
  const raw = entity[key];
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
};

const idOf = (entity: Readonly<Record<string, unknown>>) =>
  typeof entity["id"] === "string" ? entity["id"] : "(unknown)";
const nameOf = (entity: Readonly<Record<string, unknown>>) =>
  typeof entity["name"] === "string" ? entity["name"] : idOf(entity);

/** No financial quantity in these schemas can legitimately be negative. */
function negativeValues(
  entity: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): readonly Breach[] {
  const breaches: Breach[] = [];
  for (const field of fields) {
    const value = num(entity, field);
    if (value !== null && value < 0) {
      breaches.push({
        check: "non_negative",
        entityId: idOf(entity),
        entityName: nameOf(entity),
        detail: `${field} is negative (${value}), which no accounting can produce.`,
        values: { [field]: String(value) },
      });
    }
  }
  return breaches;
}

const LENDING: InvariantSpec = {
  requirement: R3_LENDING,
  fields: [
    "id",
    "name",
    "totalValueLockedUSD",
    "totalDepositBalanceUSD",
    "totalBorrowBalanceUSD",
    "inputTokenBalance",
  ],
  check(entity) {
    const breaches = [
      ...negativeValues(entity, [
        "totalValueLockedUSD",
        "totalDepositBalanceUSD",
        "totalBorrowBalanceUSD",
      ]),
    ];

    const deposits = num(entity, "totalDepositBalanceUSD");
    const borrows = num(entity, "totalBorrowBalanceUSD");
    if (deposits !== null && borrows !== null && deposits > 0 && borrows > deposits) {
      breaches.push({
        check: "borrows_within_deposits",
        entityId: idOf(entity),
        entityName: nameOf(entity),
        detail:
          `Outstanding borrows (${borrows}) exceed total deposits (${deposits}). ` +
          "A market cannot have lent out more than was supplied to it.",
        values: {
          totalDepositBalanceUSD: String(deposits),
          totalBorrowBalanceUSD: String(borrows),
        },
      });
    }

    const tvl = num(entity, "totalValueLockedUSD");
    const balance = num(entity, "inputTokenBalance");
    if (tvl !== null && balance !== null && tvl > 0 && balance === 0) {
      breaches.push({
        check: "value_backed_by_balance",
        entityId: idOf(entity),
        entityName: nameOf(entity),
        detail:
          `Market reports ${tvl} USD locked while holding zero underlying tokens.`,
        values: { totalValueLockedUSD: String(tvl), inputTokenBalance: "0" },
      });
    }

    return breaches;
  },
};

const DEX: InvariantSpec = {
  requirement: R3_DEX,
  fields: ["id", "name", "totalValueLockedUSD", "inputTokenBalances", "cumulativeVolumeUSD"],
  check(entity) {
    const breaches = [
      ...negativeValues(entity, ["totalValueLockedUSD", "cumulativeVolumeUSD"]),
    ];

    const tvl = num(entity, "totalValueLockedUSD");
    const balances = entity["inputTokenBalances"];
    if (
      tvl !== null &&
      tvl > 0 &&
      Array.isArray(balances) &&
      balances.length > 0 &&
      balances.every((b) => Number(b) === 0)
    ) {
      breaches.push({
        check: "value_backed_by_balance",
        entityId: idOf(entity),
        entityName: nameOf(entity),
        detail: `Pool reports ${tvl} USD locked while every token balance is zero.`,
        values: { totalValueLockedUSD: String(tvl), inputTokenBalances: "all zero" },
      });
    }

    return breaches;
  },
};

const VAULT: InvariantSpec = {
  requirement: R3_VAULT,
  fields: [
    "id",
    "name",
    "totalValueLockedUSD",
    "inputTokenBalance",
    "outputTokenSupply",
    "pricePerShare",
  ],
  check(entity) {
    const breaches = [
      ...negativeValues(entity, [
        "totalValueLockedUSD",
        "inputTokenBalance",
        "outputTokenSupply",
        "pricePerShare",
      ]),
    ];

    const shares = num(entity, "outputTokenSupply");
    const balance = num(entity, "inputTokenBalance");
    if (shares !== null && balance !== null && shares > 0 && balance === 0) {
      breaches.push({
        check: "shares_backed_by_assets",
        entityId: idOf(entity),
        entityName: nameOf(entity),
        detail:
          `Vault has ${shares} shares outstanding against zero underlying balance. ` +
          "Every share is a claim on nothing.",
        values: { outputTokenSupply: String(shares), inputTokenBalance: "0" },
      });
    }

    return breaches;
  },
};

const SPECS: Readonly<Record<string, InvariantSpec>> = {
  "lending-cdp": LENDING,
  "dex-amm": DEX,
  "yield-vault": VAULT,
};

/**
 * Everything R3 needs from the operational layer, behind one interface so the
 * rule can be tested without a gateway, a registry or a network.
 */
export interface ProtocolContext {
  /** Which schema family indexes this contract, if any. */
  identifyFamily(
    address: Address,
    network: NetworkId,
  ): Promise<SchemaFamily | null>;
  /** Which deployments can serve R3 for this family right now. */
  resolveCapability(
    requirement: RuleRequirement,
    network: NetworkId,
  ): Promise<CapabilityResolution>;
  /** Execute a query against a pinned deployment. */
  query<T>(deploymentId: string, query: string): Promise<T>;
}

export interface InvariantBreachRuleOptions {
  readonly protocol: ProtocolContext;
  /** Entities examined per protocol, largest first. */
  readonly sampleSize?: number;
  /**
   * Override the freshness budget for every family.
   *
   * The budget must travel with the requirement rather than be applied
   * elsewhere, so that the unavailability message quotes the budget actually
   * enforced. A diagnostic that names a different number than the one that
   * caused the refusal sends an operator looking for the wrong problem.
   */
  readonly maxLagSeconds?: number;
  readonly now?: () => Date;
}

export class InvariantBreachRule implements Rule {
  readonly id = "R3";
  readonly title = "Protocol invariant breach";

  readonly #protocol: ProtocolContext;
  readonly #sampleSize: number;
  readonly #maxLagSeconds: number | null;
  readonly #now: () => Date;

  constructor(options: InvariantBreachRuleOptions) {
    this.#protocol = options.protocol;
    this.#sampleSize = options.sampleSize ?? 10;
    this.#maxLagSeconds = options.maxLagSeconds ?? null;
    this.#now = options.now ?? (() => new Date());
  }

  async evaluate(context: RuleContext): Promise<RuleOutcome> {
    const { transaction } = context;
    if (transaction.to === null) return evaluated([]);

    const network = CHAIN_TO_NETWORK[transaction.chainId];
    if (network === undefined) {
      return {
        status: "unavailable",
        reason: "unsupported_network",
        detail: `no indexed data is configured for chain ${transaction.chainId}`,
      };
    }

    const target = transaction.to.toLowerCase() as Address;
    const family = await this.#protocol.identifyFamily(target, network);

    // Not a protocol this rule knows how to reason about. That is not a
    // failure of R3 — the "unidentified counterparty" case is the engine's to
    // report, and duplicating it here would double-count one fact.
    if (family === null) return evaluated([]);

    const spec = SPECS[family];
    if (spec === undefined) return evaluated([]);

    const requirement: RuleRequirement =
      this.#maxLagSeconds === null
        ? spec.requirement
        : { ...spec.requirement, maxLagSeconds: this.#maxLagSeconds };

    const resolution = await this.#protocol.resolveCapability(requirement, network);

    // The fail-closed core. Stale or missing context cannot produce a clean
    // result, only an honest refusal to answer.
    if (!resolution.satisfied) {
      return {
        status: "unavailable",
        reason: resolution.reason,
        detail:
          `No deployment can currently answer R3 for ${family} on ${network} ` +
          `within ${requirement.maxLagSeconds}s of chain head ` +
          `(${resolution.rejected.length} candidate(s) rejected).`,
      };
    }

    const record = resolution.records[0];
    if (record === undefined) {
      return {
        status: "unavailable",
        reason: "no_candidates",
        detail: `capability reported satisfied with no deployments for ${family}`,
      };
    }

    const query = `{ ${requirement.rootField}(first: ${this.#sampleSize}, orderBy: totalValueLockedUSD, orderDirection: desc) { ${spec.fields.join(" ")} } }`;

    let entities: readonly Record<string, unknown>[];
    try {
      const data = await this.#protocol.query<Record<string, unknown>>(
        record.candidate.deploymentId,
        query,
      );
      const rows = data[requirement.rootField];
      entities = Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
    } catch (error) {
      // A query that fails is not a protocol that is healthy.
      return {
        status: "unavailable",
        reason: "query_failed",
        detail: error instanceof Error ? error.message : String(error),
      };
    }

    const lagSeconds = Number(effectiveLagSeconds(record, this.#now()).toFixed(1));
    const findings: Finding[] = [];

    for (const entity of entities) {
      for (const breach of spec.check(entity)) {
        findings.push({
          ruleId: this.id,
          severity: "critical",
          title: `Protocol accounting is inconsistent: ${breach.entityName}`,
          detail: breach.detail,
          evidence: {
            check: breach.check,
            schema_family: family,
            entity_id: breach.entityId,
            entity_name: breach.entityName,
            values: breach.values,
            // Provenance travels with the finding, not just the verdict: a
            // breach claim is only checkable if the reader knows which
            // deployment said so and how stale it was.
            deployment_id: record.candidate.deploymentId,
            deployment_name: record.candidate.displayName,
            effective_lag_seconds: lagSeconds,
            indexed_block: record.liveness.indexedBlock,
            derived_from: "indexed_protocol_data",
          },
        });
      }
    }

    return evaluated(findings);
  }
}
