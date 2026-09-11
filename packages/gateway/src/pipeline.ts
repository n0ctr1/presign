/**
 * One decision about one unsigned transaction.
 *
 * Composes the verdict engine, the escalation policy and — when a device is
 * present — human confirmation. Every component already exists; what this adds
 * is the guarantee that they are consulted in the right order and that no
 * caller can skip a step by accident.
 *
 * The pipeline never signs on the agent's behalf. For a low-risk transaction
 * it says "you may sign", not "here is a signature": the agent's own key is
 * not ours to use, and a service that could sign would be a custodian rather
 * than an advisor.
 */

import {
  TIER_ACTION,
  type RiskTier,
  type UnsignedTransaction,
  type Verdict,
  type VerdictEngine,
} from "@presign/verdict-engine";

/** A signature produced by whatever holds the key. */
export interface Signature {
  readonly r: string;
  readonly s: string;
  readonly v: number;
}

/**
 * Something that can put a transaction in front of a human and return their
 * decision.
 *
 * An interface so the pipeline does not depend on Ledger. A deployment with no
 * device omits it and gets `escalation_required` for the medium tier, which is
 * an honest answer rather than a degraded one.
 */
export interface ConfirmationRequester {
  request(
    transaction: unknown,
    verdict: Verdict,
  ): Promise<
    | { approved: true; signature: Signature; clearSigned: boolean }
    | { approved: false; reason: string; detail: string }
  >;
}

export type PipelineDecision =
  /** Low risk. The agent proceeds with its own key. */
  | { readonly decision: "may_sign"; readonly verdict: Verdict }
  /** Medium risk, confirmed on a device that decoded it, signature returned. */
  | {
      readonly decision: "signed_after_confirmation";
      readonly verdict: Verdict;
      readonly signature: Signature;
    }
  /** Medium risk, but no device is configured. Not a failure. */
  | { readonly decision: "escalation_required"; readonly verdict: Verdict }
  /** Medium risk, and the human said no. */
  | {
      readonly decision: "declined_by_human";
      readonly verdict: Verdict;
      readonly detail: string;
    }
  /** Medium risk, and the device could not be asked. */
  | {
      readonly decision: "escalation_failed";
      readonly verdict: Verdict;
      readonly reason: string;
      readonly detail: string;
    }
  /** High risk or unavailable context. Never reaches a device. */
  | {
      readonly decision: "refused";
      readonly verdict: Verdict;
      readonly rationale: string;
    };

export interface PresignPipelineOptions {
  readonly engine: VerdictEngine;
  /** Omit when no device is available. */
  readonly confirmation?: ConfirmationRequester;
}

/** Human-readable one-liner, safe to log or show. */
export function describe(outcome: PipelineDecision): string {
  const tier = outcome.verdict.tier.toUpperCase();
  switch (outcome.decision) {
    case "may_sign":
      return `${tier} — agent may sign`;
    case "signed_after_confirmation":
      return `${tier} — confirmed on device`;
    case "escalation_required":
      return `${tier} — human confirmation required, no device configured`;
    case "declined_by_human":
      return `${tier} — declined by human`;
    case "escalation_failed":
      return outcome.reason === "blind_signed"
        ? `${tier} — BLIND SIGNED on device, signature discarded`
        : `${tier} — could not reach the device: ${outcome.reason}`;
    case "refused":
      return `${tier} — refused`;
  }
}

export class PresignPipeline {
  readonly #engine: VerdictEngine;
  readonly #confirmation: ConfirmationRequester | undefined;

  constructor(options: PresignPipelineOptions) {
    this.#engine = options.engine;
    this.#confirmation = options.confirmation;
  }

  /** Verdict only, with no device interaction. */
  evaluate(transaction: UnsignedTransaction): Promise<Verdict> {
    return this.#engine.evaluate(transaction);
  }

  /**
   * Evaluate, and carry the result through to its conclusion.
   *
   * `signable` carries the nonce and fee a signature commits to. It is passed
   * to the confirmation requester untouched but is **not** what gets judged:
   * the rules read the assessment shape, and conflating the two would let a
   * caller believe a fee chosen after the verdict was covered by it.
   */
  async run(
    transaction: UnsignedTransaction,
    signable: unknown = transaction,
  ): Promise<PipelineDecision> {
    const verdict = await this.#engine.evaluate(transaction);

    // High and unavailable stop here, before any device is involved. Showing a
    // human a transaction already judged dangerous invites approval, and
    // "I could not check this" is not a question to delegate to someone with
    // less information than the service that gave up.
    if (verdict.tier === "high" || verdict.tier === "unavailable") {
      return {
        decision: "refused",
        verdict,
        rationale: TIER_ACTION[verdict.tier as RiskTier],
      };
    }

    if (verdict.tier === "low") {
      return { decision: "may_sign", verdict };
    }

    if (this.#confirmation === undefined) {
      // Not a degraded "allow": the caller is told plainly that a human still
      // has to look, and it is their business how.
      return { decision: "escalation_required", verdict };
    }

    const result = await this.#confirmation.request(signable, verdict);

    if (result.approved) {
      /*
       * A blind signature is not a confirmation. The human approved a hash the
       * device could not decode, so what they agreed to is unknown, and handing
       * the signature on would present a medium-risk transaction as checked by
       * a person when nobody saw it. It is dropped here rather than flagged
       * for a caller to remember to check.
       */
      if (!result.clearSigned) {
        return {
          decision: "escalation_failed",
          verdict,
          reason: "blind_signed",
          detail:
            "The device fell back to blind signing, so the human approved a hash rather " +
            "than the decoded transaction. The signature was discarded.",
        };
      }
      return { decision: "signed_after_confirmation", verdict, signature: result.signature };
    }

    if (result.reason === "rejected_on_device") {
      return { decision: "declined_by_human", verdict, detail: result.detail };
    }

    // Everything else — a fault, a timeout, a cancelled action — is reported
    // as a failure to ask, never as a refusal by a person who was never asked.
    return {
      decision: "escalation_failed",
      verdict,
      reason: result.reason,
      detail: result.detail,
    };
  }
}
