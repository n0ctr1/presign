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
  type DeploymentCandidate,
  type DeploymentRecord,
  type NetworkId,
  type RuleRequirement,
} from "@presign/operational-layer";

import { evaluated } from "../types.js";
import type {
  Address,
  Finding,
  Rule,
  RuleContext,
  RuleOutcome,
  VerdictSource,
} from "../types.js";

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
/**
 * The result of probing one deployment.
 *
 * Two arms rather than a nullable record, because collapsing them is a
 * fail-open. "I asked and this deployment does not speak the schema" and "I
 * could not ask" look identical as `null`, and a rule that treats both as
 * `evaluated([])` reports a green verdict when every probe failed — which is
 * exactly what happened the first time this project funded queries with a
 * wallet that had no money in it. Every probe was refused, R3 reported
 * nothing found, and a call to Aave came back `low` with no source named.
 */
export type ProbeOutcome =
  | { readonly status: "probed"; readonly record: DeploymentRecord }
  | { readonly status: "failed"; readonly reason: string };

export interface ProtocolContext {
  /** Deployments whose manifest indexes this contract. */
  findIndexingDeployments(
    address: Address,
    network: NetworkId,
  ): Promise<readonly DeploymentCandidate[]>;
  /** Conformance and liveness for one deployment against one requirement. */
  probeDeployment(
    candidate: DeploymentCandidate,
    requirement: RuleRequirement,
    network: NetworkId,
  ): Promise<ProbeOutcome>;
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

  /** The spec's requirement, with any caller override of the freshness budget. */
  #requirementFor(spec: InvariantSpec): RuleRequirement {
    return this.#maxLagSeconds === null
      ? spec.requirement
      : { ...spec.requirement, maxLagSeconds: this.#maxLagSeconds };
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

    /*
     * Source selection is the subtle part, and getting it wrong is a category
     * error rather than a small inaccuracy.
     *
     * Appearing in a subgraph's manifest does not make a contract an instance
     * of that subgraph's protocol. USDC is indexed by Hop's and SOMA's
     * subgraphs; treating it as "a DEX" on that basis and then checking pool
     * invariants against it is nonsense. So the protocol context is the
     * deployment that indexes this very contract, and it only counts if it
     * actually speaks the standard schema.
     *
     * Conformance and liveness are then read as answers to different
     * questions, and the split is what keeps this honest. Conformance asks
     * *what this counterparty is*: a deployment that claims a family but
     * cannot answer its fields tells us the classification is unreliable, and
     * R3 has nothing to say. Liveness asks *whether we can see it right now*:
     * a conforming deployment that is stale is a protocol we should be able to
     * check and currently cannot, which is the fail-closed case.
     */
    const indexing = await this.#protocol.findIndexingDeployments(target, network);

    const specced = indexing.flatMap((candidate) => {
      const family = candidate.schemaFamily;
      if (family === null) return [];
      const spec = SPECS[family];
      return spec === undefined ? [] : [{ candidate, spec, family }];
    });

    if (specced.length === 0) return evaluated([]);

    const probed = await Promise.all(
      specced.map(async (entry) => ({
        ...entry,
        outcome: await this.#protocol.probeDeployment(
          entry.candidate,
          this.#requirementFor(entry.spec),
          network,
        ),
      })),
    );

    const failures = probed.filter((entry) => entry.outcome.status === "failed");

    const conforming = probed.flatMap((entry) =>
      entry.outcome.status === "probed" &&
      entry.outcome.record.conformance.missingFields.length === 0 &&
      !entry.outcome.record.liveness.hasIndexingErrors
        ? [{ ...entry, record: entry.outcome.record }]
        : [],
    );

    if (conforming.length === 0) {
      /*
       * A probe that failed is not a deployment that does not conform.
       *
       * If anything could not be reached, a conforming deployment may be
       * sitting behind the failure, and reporting "nothing to check here"
       * would be a green answer resting on data we never saw. Only when every
       * probe actually completed is the empty result a finding about the
       * counterparty rather than about us.
       */
      if (failures.length > 0) {
        const reasons = [
          ...new Set(
            failures.map((entry) =>
              entry.outcome.status === "failed" ? entry.outcome.reason : "",
            ),
          ),
        ];
        return {
          status: "unavailable",
          reason: "probe_failed",
          detail:
            `${failures.length} of ${probed.length} deployment(s) indexing ${target} could ` +
            `not be probed, so whether any of them can answer for this protocol is ` +
            `unknown: ${reasons.join("; ")}`,
        };
      }

      // Every probe completed and nothing speaks a schema we can reason about,
      // so the counterparty is not a protocol instance R3 evaluates. R1, R2
      // and the unidentified-contract class carry the verdict from here.
      return evaluated([]);
    }

    const now = this.#now();
    const fresh = conforming
      .map((entry) => ({ ...entry, lag: effectiveLagSeconds(entry.record, now) }))
      .filter(
        (entry) => entry.lag <= this.#requirementFor(entry.spec).maxLagSeconds,
      )
      .sort((a, b) => a.lag - b.lag);

    if (fresh.length === 0) {
      const budget = this.#requirementFor(conforming[0]!.spec).maxLagSeconds;
      return {
        status: "unavailable",
        reason: "all_candidates_stale",
        detail:
          `${conforming.length} deployment(s) index ${target} and speak the ` +
          `${conforming[0]!.family} schema, but none is within ${budget}s of chain ` +
          "head, so no current view of this protocol's accounting is available.",
      };
    }

    /*
     * The freshest deployment first, then the next, until one answers.
     *
     * Every candidate here already passed conformance and sits inside the
     * freshness budget, so falling through the list trades nothing away: the
     * second choice is as current as the first and speaks the same schema. It
     * is only *ranked* lower, and ranking is by lag.
     *
     * Taking only the head made one slow indexer decide the verdict. A DEX
     * subgraph timing out on the data query turned a call to the Uniswap V3
     * factory into `unavailable` — do not sign — while another deployment
     * indexing the same contract sat one place down the list, healthy and four
     * seconds behind head. Refusing there is not caution, it is a refusal we
     * had the data to avoid.
     *
     * Exhausting the list is still `unavailable`, and it must be: at that
     * point nothing current could answer, which is the case this tier exists
     * for.
     */
    const attempts: string[] = [];
    let answered:
      | { entry: (typeof fresh)[number]; entities: readonly Record<string, unknown>[] }
      | null = null;

    for (const candidate of fresh) {
      const requirementFor = this.#requirementFor(candidate.spec);
      const text = `{ ${requirementFor.rootField}(first: ${this.#sampleSize}, orderBy: totalValueLockedUSD, orderDirection: desc) { ${candidate.spec.fields.join(" ")} } }`;
      try {
        const data = await this.#protocol.query<Record<string, unknown>>(
          candidate.record.candidate.deploymentId,
          text,
        );
        const rows = data[requirementFor.rootField];
        answered = {
          entry: candidate,
          entities: Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [],
        };
        break;
      } catch (error) {
        attempts.push(
          `${candidate.record.candidate.displayName}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (answered === null) {
      // A query that fails is not a protocol that is healthy.
      return {
        status: "unavailable",
        reason: "query_failed",
        detail: `none of ${fresh.length} fresh deployment(s) answered — ${attempts.join("; ")}`,
      };
    }

    const chosen = answered.entry;
    const spec = chosen.spec;
    const family = chosen.family;
    const record = chosen.record;
    const requirement = this.#requirementFor(spec);
    const entities = answered.entities;

    const lagSeconds = Number(chosen.lag.toFixed(1));
    const findings: Finding[] = [];

    for (const entity of entities) {
      for (const breach of spec.check(entity)) {
        findings.push({
          ruleId: this.id,
          severity: "critical",
          standing: true,
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

    const source: VerdictSource = {
      deploymentId: record.candidate.deploymentId,
      displayName: record.candidate.displayName,
      effectiveLagSeconds: lagSeconds,
      measuredAt: record.liveness.checkedAt.toISOString(),
    };

    // Reported whether or not anything was found: a clean R3 result is a claim
    // about a specific deployment at a specific staleness, and without naming
    // it the "no breach" half of the verdict is unfalsifiable.
    return evaluated(findings, [source]);
  }
}
