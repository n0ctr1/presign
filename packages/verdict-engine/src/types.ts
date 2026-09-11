/**
 * Vocabulary of a pre-signature verdict.
 *
 * The object under judgement is an **unsigned** transaction. Not a hash, not a
 * signed payload: by the time either of those exists the decision has already
 * been made, and an advisor that can only comment afterwards is a monitoring
 * tool wearing the wrong label.
 */

import type { Address, Hex } from "viem";

export type { Address, Hex };

/** What the agent is about to sign. */
export interface UnsignedTransaction {
  readonly from: Address;
  /** Null for contract creation, which is its own risk story. */
  readonly to: Address | null;
  readonly value: bigint;
  readonly data: Hex;
  readonly chainId: number;
}

/**
 * What the caller should do, not merely how bad things look.
 *
 * `unavailable` is a first-class outcome rather than an error, and it is the
 * whole reason the tiers are shaped this way. When fresh protocol context
 * cannot be obtained, the honest answer is "I could not evaluate this", and
 * that must be structurally impossible to confuse with `low`.
 */
export type RiskTier = "low" | "medium" | "high" | "unavailable";

/** Action the tier implies, spelled out so a caller cannot invent its own mapping. */
export const TIER_ACTION: Readonly<Record<RiskTier, string>> = {
  low: "The agent may sign without further confirmation.",
  medium: "Escalate to on-device human confirmation before signing.",
  high: "Do not sign. Report the finding.",
  unavailable:
    "Do not sign. Fresh context was unavailable, which is not the same as safe.",
};

export type Severity = "info" | "warning" | "critical";

/**
 * One thing a rule concluded, with the evidence that supports it.
 *
 * `evidence` is not decoration. A verdict a caller cannot check is a number
 * they have to trust, and the entire argument of this project is that
 * unverifiable risk scores are what the incumbents already sell.
 */
export interface Finding {
  readonly ruleId: string;
  /**
   * True when the finding describes a standing property of the counterparty
   * rather than something this transaction does.
   *
   * The distinction drives tiering. "This contract is upgradeable" is true of
   * every call to it and cannot be the reason to refuse this one; "this
   * transaction replaces the implementation" is about the call under
   * judgement. Collapsing the two either cries wolf on every interaction with
   * an ordinary proxy, or lets a live upgrade slip through at the same tier as
   * a dormant one.
   */
  readonly standing?: boolean;
  readonly severity: Severity;
  /** One line, safe to show a human on a device screen. */
  readonly title: string;
  /** What was concluded and why. */
  readonly detail: string;
  /** Machine-checkable support: slots, addresses, values, deployment ids. */
  readonly evidence: Readonly<Record<string, unknown>>;
}

/**
 * Where the answer came from and how stale it was.
 *
 * This is the field the incumbents do not return. A green verdict computed
 * from six-hour-old context looks identical to one computed at chain head
 * unless the response says otherwise.
 */
export interface VerdictProvenance {
  /**
   * Block the simulation ran against, or `null` when nothing was simulated.
   *
   * Null rather than the fork's block for a transaction that was never
   * executed: a block number beside a Base transaction would read as evidence
   * about that transaction, and it would be evidence about Ethereum.
   */
  readonly simulatedAtBlock: number | null;
  /** Chain the transaction is for. */
  readonly chainId: number;
  /** Indexed sources consulted, with their lag at the time of use. */
  readonly sources: readonly VerdictSource[];
  /**
   * Rules that could not run, and why. Empty is meaningful.
   *
   * `reason` is the machine-readable cause and `detail` the sentence a person
   * acts on. Carrying only the first made an operator's job impossible in
   * practice: `query_failed` says a query failed, not which deployment
   * refused, or whether the cause was a timeout, an expired key or a subgraph
   * with no indexers allocated to it. Every one of those is a different fix,
   * and the rules already write the distinction — the engine was dropping it.
   */
  readonly unavailableRules: readonly {
    readonly ruleId: string;
    readonly reason: string;
    readonly detail: string;
  }[];
}

export interface Verdict {
  readonly tier: RiskTier;
  readonly action: string;
  readonly findings: readonly Finding[];
  readonly provenance: VerdictProvenance;
  readonly evaluatedAt: string;
}

/**
 * A single account's before/after state, as `prestateTracer` reports it in
 * diff mode.
 */
export interface AccountDiff {
  readonly balance?: bigint;
  readonly nonce?: number;
  readonly code?: Hex;
  readonly storage?: Readonly<Record<Hex, Hex>>;
}

/**
 * The actual effect of the transaction, obtained by running it.
 *
 * Rules read this rather than the calldata. Calldata says what a transaction
 * claims to do; the diff says what it does. The two part company exactly where
 * it matters most — a router, a multicall, or a permit forwarding an approval
 * on someone's behalf shows nothing useful on the surface and an unmistakable
 * allowance write in the diff.
 */
export interface StateDiff {
  readonly pre: Readonly<Record<Address, AccountDiff>>;
  readonly post: Readonly<Record<Address, AccountDiff>>;
  readonly blockNumber: number;
  /** Set when the transaction reverts; rules must not read a reverted diff. */
  readonly revertReason: string | null;
}

/** Context handed to every rule. */
export interface RuleContext {
  readonly transaction: UnsignedTransaction;
  readonly diff: StateDiff;
  /** Reads chain state at the forked block. */
  readonly getStorageAt: (address: Address, slot: Hex) => Promise<Hex>;
  readonly getCode: (address: Address) => Promise<Hex>;
  /**
   * Read-only call against the fork.
   *
   * Returns null when the call reverts, rather than throwing. Probing a
   * contract for an interface it may not implement is a normal, expected
   * miss — a rule should be able to ask "are you a timelock?" without
   * wrapping every question in a try block.
   */
  readonly call: (address: Address, data: Hex) => Promise<Hex | null>;
}

/**
 * What a rule concluded, or that it could not conclude anything.
 *
 * The `unavailable` arm is the fail-closed guarantee expressed as a type. A
 * rule that returns an empty finding list is saying "I looked and found
 * nothing wrong". A rule that could not obtain fresh context must say
 * something different, and if both were an empty array the engine would have
 * no way to tell them apart — which is exactly how a green verdict gets issued
 * on absent data.
 */
export interface VerdictSource {
  readonly deploymentId: string;
  readonly displayName: string;
  readonly effectiveLagSeconds: number;
  readonly measuredAt: string;
}

export type RuleOutcome =
  | {
      readonly status: "evaluated";
      readonly findings: readonly Finding[];
      /**
       * Indexed sources the rule consulted, reported even when nothing was
       * found. A clean verdict has to name what it rested on: "no problems"
       * and "no problems, according to a deployment four seconds behind head"
       * are different claims, and only the second can be checked.
       */
      readonly sources?: readonly VerdictSource[];
    }
  | {
      readonly status: "unavailable";
      /** Machine-readable cause, e.g. `all_candidates_stale`. */
      readonly reason: string;
      readonly detail: string;
    };

/** A rule turns evidence into findings. Never throws for "nothing found". */
export interface Rule {
  readonly id: string;
  readonly title: string;
  evaluate(context: RuleContext): Promise<RuleOutcome>;
}

/** Convenience for rules that always reach a conclusion. */
export function evaluated(
  findings: readonly Finding[],
  sources?: readonly VerdictSource[],
): RuleOutcome {
  return sources === undefined
    ? { status: "evaluated", findings }
    : { status: "evaluated", findings, sources };
}
