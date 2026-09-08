/**
 * Composes rules into one verdict.
 *
 * The engine simulates once, runs every rule against the same state diff, and
 * folds the results into a tier. It deliberately holds no opinions about
 * individual risks — those belong to rules — and exactly one opinion about
 * how uncertainty is handled: it is never resolved in favour of the caller.
 */

import {
  TIER_ACTION,
  type Finding,
  type RiskTier,
  type Rule,
  type UnsignedTransaction,
  type Verdict,
  type VerdictSource,
} from "./types.js";
import type { ForkSimulator } from "./simulation/simulator.js";

/** Severity a finding contributes before any ceiling is applied. */
const SEVERITY_TIER: Readonly<Record<Finding["severity"], RiskTier>> = {
  info: "low",
  warning: "medium",
  critical: "high",
};

const TIER_ORDER: readonly RiskTier[] = ["low", "medium", "high"];

function higher(a: RiskTier, b: RiskTier): RiskTier {
  return TIER_ORDER.indexOf(a) >= TIER_ORDER.indexOf(b) ? a : b;
}

function capped(tier: RiskTier, ceiling: RiskTier | undefined): RiskTier {
  if (ceiling === undefined) return tier;
  return TIER_ORDER.indexOf(tier) <= TIER_ORDER.indexOf(ceiling) ? tier : ceiling;
}

export interface TierPolicy {
  /**
   * Highest tier a rule's **standing** findings may reach on their own.
   *
   * R2 is capped at medium by default. "This contract is upgradeable" is true
   * of every call to an ordinary proxy — USDC included, whose admin is a plain
   * EOA — so letting it reach `high` would refuse most real transactions and
   * train the caller to ignore the verdict. Medium is the honest response: a
   * human looks at it. The cap deliberately does not apply to findings about
   * the transaction itself, so an implementation swap inside the call under
   * judgement still reaches `high`.
   */
  readonly standingCeilings?: Readonly<Record<string, RiskTier>>;
}

export const DEFAULT_TIER_POLICY: TierPolicy = {
  standingCeilings: { R2: "medium" },
};

export interface VerdictEngineOptions {
  readonly simulator: ForkSimulator;
  readonly rules: readonly Rule[];
  readonly policy?: TierPolicy;
  readonly now?: () => Date;
}

export class VerdictEngine {
  readonly #simulator: ForkSimulator;
  readonly #rules: readonly Rule[];
  readonly #policy: TierPolicy;
  readonly #now: () => Date;

  constructor(options: VerdictEngineOptions) {
    this.#simulator = options.simulator;
    this.#rules = options.rules;
    this.#policy = options.policy ?? DEFAULT_TIER_POLICY;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Produce a verdict.
   *
   * The whole body runs under one fork lease. The simulation and the rules
   * must see the same block — the diff says what the transaction changes, and
   * R2 and R4 then read storage and code to explain it — so a fork that
   * refreshed in the middle would have a rule reasoning about one block using
   * evidence from another.
   */
  evaluate(transaction: UnsignedTransaction): Promise<Verdict> {
    return this.#simulator.withFreshFork(() => this.#evaluate(transaction));
  }

  async #evaluate(transaction: UnsignedTransaction): Promise<Verdict> {
    const diff = await this.#simulator.simulate(transaction);
    const context = {
      transaction,
      diff,
      ...this.#simulator.asRuleReaders(),
    };

    const findings: Finding[] = [];
    const sources: VerdictSource[] = [];
    const unavailableRules: { ruleId: string; reason: string }[] = [];

    // Rules are independent, so one throwing must not lose the others'
    // conclusions. A rule that fails is treated as unavailable rather than as
    // having found nothing.
    const outcomes = await Promise.all(
      this.#rules.map(async (rule) => {
        try {
          return { rule, outcome: await rule.evaluate(context) };
        } catch (error) {
          return {
            rule,
            outcome: {
              status: "unavailable" as const,
              reason: "rule_error",
              detail: error instanceof Error ? error.message : String(error),
            },
          };
        }
      }),
    );

    for (const { rule, outcome } of outcomes) {
      if (outcome.status === "unavailable") {
        unavailableRules.push({ ruleId: rule.id, reason: outcome.reason });
        continue;
      }
      findings.push(...outcome.findings);
      sources.push(...(outcome.sources ?? []));
    }

    if (diff.revertReason !== null) {
      findings.push({
        ruleId: "SIM",
        severity: "info",
        standing: false,
        title: "Transaction reverts in simulation",
        detail:
          "This transaction fails when executed against current state, so it changes " +
          "nothing on success paths. It will still consume gas if submitted.",
        evidence: { revert_reason: diff.revertReason, derived_from: "simulation" },
      });
    }

    return {
      tier: this.#tier(findings, unavailableRules.length > 0),
      action: TIER_ACTION[this.#tier(findings, unavailableRules.length > 0)],
      findings,
      provenance: {
        simulatedAtBlock: diff.blockNumber,
        chainId: transaction.chainId,
        sources,
        unavailableRules,
      },
      evaluatedAt: this.#now().toISOString(),
    };
  }

  /**
   * Fold findings into a tier.
   *
   * Two orderings matter here. A definite finding outranks uncertainty: if a
   * rule proved something wrong, the caller should hear that rather than
   * "could not evaluate". But the absence of findings does not outrank
   * uncertainty — a clean result from the rules that ran says nothing about
   * the rule that could not run, and reporting `low` there is exactly the
   * fail-open this project exists to prevent.
   */
  #tier(findings: readonly Finding[], anyUnavailable: boolean): RiskTier {
    let tier: RiskTier = "low";

    for (const finding of findings) {
      const raw = SEVERITY_TIER[finding.severity];
      const ceiling =
        finding.standing === true
          ? this.#policy.standingCeilings?.[finding.ruleId]
          : undefined;
      tier = higher(tier, capped(raw, ceiling));
    }

    if (anyUnavailable && tier === "low") return "unavailable";
    return tier;
  }
}
