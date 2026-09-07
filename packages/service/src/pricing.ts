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

/** Rules a caller may request. Ordered by what they cost to run. */
export const RULE_IDS = ["R1", "R2", "R3"] as const;
export type RuleId = (typeof RULE_IDS)[number];

/** HBAR is quoted in tinybars: 1 HBAR = 100_000_000 tinybars. */
export const TINYBARS_PER_HBAR = 100_000_000n;

/**
 * Base charge covering simulation and the rules that need no purchased data.
 *
 * Deliberately small. The fork, the RPC calls and the rule evaluation are our
 * fixed costs; charging much for them would price out exactly the
 * high-frequency agents this is meant for.
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

/** Tinybars to a decimal HBAR string, without floating point. */
export function formatHbar(tinybars: bigint): string {
  const whole = tinybars / TINYBARS_PER_HBAR;
  const fraction = (tinybars % TINYBARS_PER_HBAR)
    .toString()
    .padStart(8, "0")
    .replace(/0+$/, "");
  return fraction === "" ? `${whole}` : `${whole}.${fraction}`;
}
