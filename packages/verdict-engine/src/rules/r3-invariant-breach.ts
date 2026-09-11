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
import { plainText, quotedName } from "./untrusted-text.js";
import type {
  Address,
  Finding,
  Hex,
  Rule,
  RuleContext,
  RuleOutcome,
  VerdictSource,
} from "../types.js";

const SELECTOR = {
  factory: "0xc45a0155",
  token0: "0x0dfe1681",
  token1: "0xd21220a7",
  fee: "0xddca3f43",
  /** `getPool(address,address,uint24)`, the Uniswap V3 shape. */
  getPool: "0x1698ee82",
  /** `getPair(address,address)`, the Uniswap V2 shape. */
  getPair: "0xe6a43905",
} as const;

const WORD = /^0x[0-9a-fA-F]{64}$/;

/** The block a response was answered at, from its own `_meta`; null when absent. */
function metaOf(
  value: unknown,
): { block: number; timestamp: number; hasIndexingErrors: boolean } | null {
  if (typeof value !== "object" || value === null) return null;
  const meta = value as {
    block?: { number?: unknown; timestamp?: unknown } | null;
    hasIndexingErrors?: unknown;
  };
  const block = meta.block?.number;
  const timestamp = meta.block?.timestamp;
  if (typeof block !== "number" || typeof timestamp !== "number") return null;
  // Absent is read as erroring, as the liveness probe reads it.
  return { block, timestamp, hasIndexingErrors: meta.hasIndexingErrors !== false };
}

/** An ABI-encoded address, or null for anything else including zero. */
function addressOf(word: Hex | null): Address | null {
  if (word === null || !WORD.test(word) || !/^0x0{24}/.test(word)) return null;
  const address = `0x${word.slice(26)}`.toLowerCase() as Address;
  return /^0x0{40}$/.test(address) ? null : address;
}

export interface ConfirmedFactory {
  readonly factory: Address;
  readonly confirmedBy: "getPool" | "getPair";
}

/**
 * The factory that created a pool, when the factory itself vouches for it.
 *
 * DEX subgraphs index pools through templates: the manifest names the factory,
 * and each pool it creates becomes a data source at runtime. Asking the
 * registry which deployments index a pool's *address* therefore finds almost
 * nothing — only subgraphs that happen to list that pool statically. For the
 * Uniswap V3 USDC/WETH pool the address lookup returned two deployments that do
 * not speak the schema and one whose only indexer was down, and R3 refused,
 * correctly: a conforming deployment might have been behind the failure. One
 * was, reachable through the factory and six seconds behind head.
 *
 * `factory()` alone proves nothing, since any contract can return Uniswap's
 * factory address to borrow its standing. So the claim is checked from the
 * other side: the factory is asked for the pool at this pool's own tokens and
 * fee tier, and must answer with this address. A contract that lies about its
 * factory fails that and is left to the address lookup alone.
 */
export async function confirmedFactory(
  pool: Address,
  call: RuleContext["call"],
): Promise<ConfirmedFactory | null> {
  const factory = addressOf(await call(pool, SELECTOR.factory));
  if (factory === null) return null;

  const [rawToken0, rawToken1, fee] = await Promise.all([
    call(pool, SELECTOR.token0),
    call(pool, SELECTOR.token1),
    call(pool, SELECTOR.fee),
  ]);
  const token0 = addressOf(rawToken0);
  const token1 = addressOf(rawToken1);
  if (token0 === null || token1 === null) return null;

  const pad = (address: Address) => address.slice(2).padStart(64, "0");
  const v3 = fee !== null && WORD.test(fee);
  const answer = addressOf(
    await call(
      factory,
      (v3
        ? `${SELECTOR.getPool}${pad(token0)}${pad(token1)}${fee.slice(2)}`
        : `${SELECTOR.getPair}${pad(token0)}${pad(token1)}`) as Hex,
    ),
  );
  if (answer !== pool.toLowerCase()) return null;
  return { factory, confirmedBy: v3 ? "getPool" : "getPair" };
}

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

/**
 * The deployments R3 will probe for a counterparty, before probing any.
 *
 * Shared by the rule and by anything that prices a verdict, so a price quoted
 * before payment counts exactly the deployments the rule then reads — not an
 * estimate of them that could drift from the code that spends the queries.
 * It costs registry lookups and, for a pool, a few calls against the fork;
 * nothing here queries the metered gateway.
 */
async function planCandidates(
  protocol: Pick<ProtocolContext, "findIndexingDeployments">,
  target: Address,
  network: NetworkId,
  call: RuleContext["call"],
) {
  const direct = await protocol.findIndexingDeployments(target, network);

  /*
   * Deployments that index the counterparty through the factory that made
   * it. These are asked about this one entity by id, never for a sample of
   * the protocol, because they index every pool the factory ever created and
   * the verdict is about this pool.
   */
  const resolved = await confirmedFactory(target, call);
  const viaFactory =
    resolved === null
      ? []
      : (await protocol.findIndexingDeployments(resolved.factory, network)).filter(
          (candidate) => !direct.some((d) => d.deploymentId === candidate.deploymentId),
        );

  const indexing = [
    ...direct.map((candidate) => ({ candidate, entity: null as Address | null })),
    ...viaFactory.map((candidate) => ({ candidate, entity: target as Address | null })),
  ];

  const specced = indexing.flatMap(({ candidate, entity }) => {
    const family = candidate.schemaFamily;
    if (family === null) return [];
    const spec = SPECS[family];
    return spec === undefined ? [] : [{ candidate, spec, family, entity }];
  });

  return { resolved, specced };
}

/** How many deployments R3 would probe for this counterparty on this chain. */
export async function countInvariantCandidates(
  protocol: Pick<ProtocolContext, "findIndexingDeployments">,
  to: Address | null,
  chainId: number,
  call: RuleContext["call"],
): Promise<number> {
  const network = CHAIN_TO_NETWORK[chainId];
  if (to === null || network === undefined) return 0;
  const { specced } = await planCandidates(
    protocol,
    to.toLowerCase() as Address,
    network,
    call,
  );
  return specced.length;
}

/**
 * Deployments R3 probes for one counterparty at most.
 *
 * Every probe is a conformance check and a liveness check against the metered
 * gateway, and the service prices a verdict by this same number. Without a
 * ceiling, a contract indexed by dozens of deployments — anyone can publish a
 * subgraph naming any address — would cost queries far past what was charged.
 */
export const MAX_INVARIANT_CANDIDATES = 8;

export interface InvariantBreachRuleOptions {
  readonly protocol: ProtocolContext;
  /** Defaults to {@link MAX_INVARIANT_CANDIDATES}. */
  readonly maxCandidates?: number;
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
  readonly #maxCandidates: number;
  readonly #now: () => Date;

  constructor(options: InvariantBreachRuleOptions) {
    this.#protocol = options.protocol;
    this.#maxCandidates = options.maxCandidates ?? MAX_INVARIANT_CANDIDATES;
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
    const { resolved, specced: planned } = await planCandidates(
      this.#protocol,
      target,
      network,
      context.call,
    );
    const truncated = planned.length > this.#maxCandidates;
    const specced = planned.slice(0, this.#maxCandidates);

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

      // The ceiling is not allowed to become a clean answer. Deployments left
      // unprobed may include one that speaks the schema, so "nothing to check"
      // would rest on candidates we never looked at.
      if (truncated) {
        return {
          status: "unavailable",
          reason: "too_many_candidates",
          detail:
            `${planned.length} deployments index ${target}; the first ${specced.length} were ` +
            `probed and none can answer for this protocol, so whether one of the other ` +
            `${planned.length - specced.length} could is unknown.`,
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
    let stale = 0;
    let answered:
      | {
          entry: (typeof fresh)[number];
          entities: readonly Record<string, unknown>[];
          block: number;
          lagSeconds: number;
          measuredAt: Date;
        }
      | null = null;

    for (const candidate of fresh) {
      const requirementFor = this.#requirementFor(candidate.spec);
      const root = requirementFor.rootField;
      // `liquidityPools` → `liquidityPool`: the standard schemas pair every
      // collection with a singular lookup by id.
      const single = root.endsWith("s") ? root.slice(0, -1) : root;
      const fields = candidate.spec.fields.join(" ");
      const name = plainText(candidate.record.candidate.displayName, 80);
      /*
       * The age of the evidence is read from the response that carries it.
       *
       * The probe measured one indexer up to ten seconds ago, and the gateway
       * routes each query to whichever indexer it picks. Quoting the probe's
       * lag over data served by another, slower indexer would make this
       * project's central claim about data it never measured. `_meta` in the
       * same document is answered at the block the entities were read at, and
       * `number_gte` turns away an indexer behind the block the probe saw.
       */
      const floor = `block: { number_gte: ${candidate.record.liveness.indexedBlock} }`;
      const meta = "_meta { block { number timestamp } hasIndexingErrors }";
      const text =
        candidate.entity === null
          ? `{ ${root}(first: ${this.#sampleSize}, orderBy: totalValueLockedUSD, orderDirection: desc, ${floor}) { ${fields} } ${meta} }`
          : `{ ${single}(id: "${candidate.entity}", ${floor}) { ${fields} } ${meta} }`;
      try {
        const data = await this.#protocol.query<Record<string, unknown>>(
          candidate.record.candidate.deploymentId,
          text,
        );
        const measuredAt = this.#now();
        const answeredAt = metaOf(data["_meta"]);
        if (answeredAt === null) {
          attempts.push(`${name}: answered without _meta, so the age of its data is unknown`);
          continue;
        }
        if (answeredAt.hasIndexingErrors) {
          attempts.push(`${name}: reports indexing errors`);
          continue;
        }
        const lagSeconds = Math.max(0, measuredAt.getTime() / 1000 - answeredAt.timestamp);
        if (lagSeconds > requirementFor.maxLagSeconds) {
          stale += 1;
          attempts.push(
            `${name}: answered from block ${answeredAt.block}, ${Math.round(lagSeconds)}s behind ` +
              `head, past the ${requirementFor.maxLagSeconds}s budget`,
          );
          continue;
        }
        const at = { block: answeredAt.block, lagSeconds, measuredAt };

        if (candidate.entity === null) {
          const rows = data[root];
          answered = {
            entry: candidate,
            entities: Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [],
            ...at,
          };
          break;
        }
        const row = data[single];
        if (row === null || typeof row !== "object") {
          // Fresh and conforming, but it has not indexed this pool — a pool
          // created after its head block, or one it filters out. That is not a
          // pool with sound accounting, so the next candidate is asked.
          attempts.push(`${name}: holds no ${single} ${candidate.entity}`);
          continue;
        }
        answered = { entry: candidate, entities: [row as Record<string, unknown>], ...at };
        break;
      } catch (error) {
        attempts.push(
          `${name}: ${plainText(error instanceof Error ? error.message : String(error), 300)}`,
        );
      }
    }

    if (answered === null) {
      // Every answer arrived, and every one was older than the budget: the
      // probes were fresh, the data was not.
      if (stale === fresh.length) {
        return {
          status: "unavailable",
          reason: "all_candidates_stale",
          detail: `every fresh deployment answered with data past its freshness budget — ${attempts.join("; ")}`,
        };
      }
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
    const entities = answered.entities;

    const lagSeconds = Number(answered.lagSeconds.toFixed(1));
    const deploymentName = plainText(record.candidate.displayName, 80);
    const findings: Finding[] = [];

    for (const entity of entities) {
      for (const breach of spec.check(entity)) {
        findings.push({
          ruleId: this.id,
          severity: "critical",
          standing: true,
          // The entity's name is the subgraph author's text. Quoted and
          // stripped, it can name a pool but cannot speak for the verdict.
          title: `Protocol accounting is inconsistent: ${quotedName(breach.entityName)}`,
          detail: plainText(breach.detail, 500),
          evidence: {
            check: breach.check,
            schema_family: family,
            entity_id: plainText(breach.entityId, 128),
            entity_name: plainText(breach.entityName, 128),
            values: breach.values,
            // Provenance travels with the finding, not just the verdict: a
            // breach claim is only checkable if the reader knows which
            // deployment said so and how stale it was.
            deployment_id: record.candidate.deploymentId,
            deployment_name: deploymentName,
            effective_lag_seconds: lagSeconds,
            indexed_block: answered.block,
            ...(chosen.entity === null || resolved === null
              ? {}
              : {
                  resolved_via: {
                    factory: resolved.factory,
                    confirmed_by: resolved.confirmedBy,
                  },
                }),
            derived_from: "indexed_protocol_data",
          },
        });
      }
    }

    const source: VerdictSource = {
      deploymentId: record.candidate.deploymentId,
      displayName: deploymentName,
      effectiveLagSeconds: lagSeconds,
      measuredAt: answered.measuredAt.toISOString(),
    };

    // Reported whether or not anything was found: a clean R3 result is a claim
    // about a specific deployment at a specific staleness, and without naming
    // it the "no breach" half of the verdict is unfalsifiable.
    return evaluated(findings, [source]);
  }
}
