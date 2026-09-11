/**
 * What a verdict costs, and why.
 *
 * A flat per-request charge would be simpler, and wrong. Verdicts do not cost
 * the same amount to produce: R1 reads a simulated state diff and R2 reads
 * storage slots, both of which need only an RPC we already pay for. R3 buys
 * indexed protocol data — real queries against a metered gateway.
 *
 * So the price follows the work. An agent that only wants to know whether it
 * is about to grant an unlimited approval should not subsidise one that wants
 * a full protocol-health check, and the difference should be visible before
 * paying rather than discovered on an invoice.
 *
 * The response then reports what was actually consumed, which is the other
 * half of the same idea: a caller can see the cost of a verdict as a number
 * rather than trusting our pricing.
 */

import { LruMap, MAX_INVARIANT_CANDIDATES, type UnsignedTransaction } from "@presign/verdict-engine";

/** Rules a caller may request. Ordered by what they cost to run. */
export const RULE_IDS = ["R1", "R2", "R3", "R4"] as const;
export type RuleId = (typeof RULE_IDS)[number];

/** HBAR is quoted in tinybars: 1 HBAR = 100_000_000 tinybars. */
export const TINYBARS_PER_HBAR = 100_000_000n;

/**
 * Base charge covering simulation and the rules that need no purchased data.
 *
 * Deliberately small. The fork, the RPC calls and the rule evaluation are our
 * fixed costs; charging much for them would price out exactly the
 * high-frequency agents this is meant for.
 *
 * R4 sits here rather than carrying its own surcharge, which is a claim worth
 * defending: it reads the public registry and then a bounded number of archive
 * `eth_getCode` calls — two for a contract that predates the search horizon,
 * around twenty when it has to bisect — on the RPC the fork already needs, and
 * caches the answer per address. That cost scales with distinct counterparties
 * seen once, not with requests. R3's does scale with requests, which is the
 * whole reason it is the one rule that carries a surcharge.
 */
export const BASE_TINYBARS = 100_000n; // 0.001 HBAR

/**
 * Surcharge for R3, which buys indexed protocol data.
 *
 * Conformance costs two introspection queries plus a probe per candidate
 * deployment, and liveness one more per refresh, against a gateway that meters
 * every one. This is the only part of a verdict with a marginal cost that
 * scales with usage, so it is the only part that carries a surcharge.
 */
export const INDEXED_DATA_TINYBARS = 400_000n; // 0.004 HBAR

export interface Quote {
  readonly rules: readonly RuleId[];
  readonly tinybars: bigint;
  readonly hbar: string;
  readonly breakdown: readonly { readonly item: string; readonly tinybars: string }[];
}

/** Parse a comma-separated `rules` parameter, rejecting anything unknown. */
export function parseRules(raw: string | undefined): readonly RuleId[] {
  if (raw === undefined || raw.trim() === "") return RULE_IDS;

  const requested = raw
    .split(",")
    .map((rule) => rule.trim().toUpperCase())
    .filter((rule) => rule !== "");

  const unknown = requested.filter(
    (rule) => !RULE_IDS.includes(rule as RuleId),
  );
  if (unknown.length > 0) {
    // Silently dropping an unknown rule would charge for a check the caller
    // believes they bought and never received.
    throw new RangeError(`unknown rule(s): ${unknown.join(", ")}`);
  }

  // Deduplicated and ordered, so the same request always yields the same quote.
  return RULE_IDS.filter((rule) => requested.includes(rule));
}

export function quote(rules: readonly RuleId[]): Quote {
  const breakdown: { item: string; tinybars: string }[] = [
    { item: "simulation and local rules", tinybars: BASE_TINYBARS.toString() },
  ];
  let total = BASE_TINYBARS;

  if (rules.includes("R3")) {
    breakdown.push({
      item: "indexed protocol data (R3)",
      tinybars: INDEXED_DATA_TINYBARS.toString(),
    });
    total += INDEXED_DATA_TINYBARS;
  }

  return {
    rules,
    tinybars: total,
    hbar: formatHbar(total),
    breakdown,
  };
}

/**
 * Price per indexed deployment R3 reads, for a metered full verdict.
 *
 * The flat surcharge above charged a call to USDC — which no conforming
 * deployment speaks for, so R3 reads nothing — the same as a call to a pool
 * read from three deployments. Each deployment R3 reads costs a conformance
 * probe, a liveness check and a data query against the metered gateway, so a
 * deployment is the unit.
 */
export const PER_DEPLOYMENT_TINYBARS = 100_000n; // 0.001 HBAR

/**
 * Deployments priced at most — the same number R3 probes at most. The two used
 * to differ: the price stopped at eight while R3 probed every candidate, so a
 * counterparty indexed by dozens of deployments cost queries nobody paid for.
 */
export const MAX_PRICED_DEPLOYMENTS = MAX_INVARIANT_CANDIDATES;

export interface MeteredQuote extends Quote {
  /** Deployments R3 will read for this counterparty; null when they could not be counted. */
  readonly deployments: number | null;
}

export function meteredQuote(deployments: number | null): MeteredQuote {
  const priced =
    deployments === null
      ? MAX_PRICED_DEPLOYMENTS
      : Math.min(deployments, MAX_PRICED_DEPLOYMENTS);
  const indexed = PER_DEPLOYMENT_TINYBARS * BigInt(priced);
  const total = BASE_TINYBARS + indexed;

  const indexedItem =
    deployments === null
      ? `indexed data (R3): deployments could not be counted, priced at the ${MAX_PRICED_DEPLOYMENTS}-deployment ceiling`
      : `indexed data (R3): ${priced} deployment${priced === 1 ? "" : "s"}` +
        (deployments > MAX_PRICED_DEPLOYMENTS ? ` of ${deployments}, capped` : "") +
        ` at ${formatHbar(PER_DEPLOYMENT_TINYBARS)} HBAR each`;

  return {
    rules: RULE_IDS,
    tinybars: total,
    hbar: formatHbar(total),
    breakdown: [
      { item: "simulation, R1, R2 and R4", tinybars: BASE_TINYBARS.toString() },
      { item: indexedItem, tinybars: indexed.toString() },
    ],
    deployments,
  };
}

export interface Meter {
  quote(transaction: UnsignedTransaction): Promise<MeteredQuote>;
  /** The price already held for this counterparty, without counting anything. */
  peek(transaction: UnsignedTransaction): MeteredQuote | undefined;
}

export interface MeterOptions {
  /** How many deployments R3 would read for this transaction's counterparty. */
  readonly count: (transaction: UnsignedTransaction) => Promise<number>;
  /**
   * How long a price holds, in seconds.
   *
   * The x402 exchange prices a request twice: once for the 402, and again when
   * the paid retry is verified. A count that moved between the two would reject
   * a payment made in good faith. Five minutes is far longer than that exchange
   * and far shorter than the time it takes somebody to publish a subgraph.
   */
  readonly ttlSeconds?: number;
  /** A failed count is priced at the ceiling, but only held this long. */
  readonly failureTtlSeconds?: number;
  /**
   * Counterparties priced and remembered at most. Anyone may ask for a price
   * about any address, so the memo is bounded rather than grown per request.
   */
  readonly maxEntries?: number;
  readonly now?: () => number;
}

/**
 * Prices a full verdict by the deployments it will read, counted before payment.
 *
 * Counting costs registry lookups and a few calls against the fork — nothing
 * against the metered gateway — and uses the same selection the rule then
 * spends queries on, so the quote is what the verdict reads rather than an
 * estimate of it.
 */
export function createMeter(options: MeterOptions): Meter {
  const ttl = (options.ttlSeconds ?? 300) * 1000;
  const failureTtl = (options.failureTtlSeconds ?? 30) * 1000;
  const now = options.now ?? Date.now;
  const cache = new LruMap<string, { quote: MeteredQuote; expires: number }>(options.maxEntries ?? 10_000);
  const inflight = new Map<string, Promise<MeteredQuote>>();

  const keyOf = (transaction: UnsignedTransaction) =>
    `${transaction.chainId}:${(transaction.to ?? "create").toLowerCase()}`;
  const held = (key: string) => {
    const hit = cache.get(key);
    return hit !== undefined && now() < hit.expires ? hit.quote : undefined;
  };

  return {
    peek: (transaction) => held(keyOf(transaction)),
    quote(transaction) {
      const key = keyOf(transaction);
      const hit = held(key);
      if (hit !== undefined) return Promise.resolve(hit);

      let pending = inflight.get(key);
      if (pending === undefined) {
        pending = options
          .count(transaction)
          .then(
            (count) => ({ quote: meteredQuote(count), hold: ttl }),
            () => ({ quote: meteredQuote(null), hold: failureTtl }),
          )
          .then(({ quote: priced, hold }) => {
            cache.set(key, { quote: priced, expires: now() + hold });
            inflight.delete(key);
            return priced;
          });
        inflight.set(key, pending);
      }
      return pending;
    },
  };
}

/** Tinybars to a decimal HBAR string, without floating point. */
export function formatHbar(tinybars: bigint): string {
  const whole = tinybars / TINYBARS_PER_HBAR;
  const fraction = (tinybars % TINYBARS_PER_HBAR)
    .toString()
    .padStart(8, "0")
    .replace(/0+$/, "");
  return fraction === "" ? `${whole}` : `${whole}.${fraction}`;
}
