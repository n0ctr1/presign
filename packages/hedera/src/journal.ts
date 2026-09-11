/**
 * A verifiable record of what was decided, and when.
 *
 * The Hedera Consensus Service gives a timestamp nobody can forge after the
 * fact, including us. That matters because the only asset this project
 * accumulates is a track record: a log of verdicts that can later be checked
 * against what actually happened. A log we could rewrite would be worth
 * nothing, and one we merely promise not to rewrite is worth only as much as
 * the promise.
 *
 * ## What is published, and what is not
 *
 * The journal records a **salted commitment** to the transaction, never its
 * contents.
 *
 * A consensus log is public and permanent. Publishing an agent's `to`, `value`
 * and calldata would broadcast its entire strategy to anyone watching the
 * topic — and would do so for every customer at once.
 *
 * A plain hash is not enough, which an earlier version got wrong. The inputs
 * are guessable: an agent's address is public, and an approval to Permit2 or a
 * call to the Aave pool has one calldata. Anyone could hash their guesses and
 * learn which agent asked about what. So each entry commits to a random salt
 * plus the transaction, and the salt goes to the caller in the response and
 * nowhere else. Whoever holds both can recompute the commitment and confirm we
 * said exactly this, at exactly that time. Nobody else learns anything beyond
 * the shape of our decisions.
 *
 * The verdict itself is published in full, because a tier with no reasons is
 * not auditable, and the reasons are about the counterparty rather than about
 * the agent.
 */

import { createHash, randomBytes } from "node:crypto";

import type { UnsignedTransaction, Verdict } from "@presign/verdict-engine";

/**
 * What gets written to the topic. Kept small: HCS messages are billed by size.
 *
 * Version 1 entries carried `txHash`, an unsalted SHA-256 of the transaction;
 * version 2 replaces it with `txCommitment`.
 */
export interface JournalEntry {
  /** Schema version, so a reader can tell how to interpret older entries. */
  readonly v: 2;
  /** SHA-256 over the caller's salt and the canonical transaction fields. */
  readonly txCommitment: string;
  readonly chainId: number;
  readonly tier: Verdict["tier"];
  /** Rules that produced findings, most severe first. */
  readonly rules: readonly string[];
  /** Deployments the verdict rested on, with their staleness at the time. */
  readonly sources: readonly { readonly id: string; readonly lag: number }[];
  /** Rules that could not run. Their presence is why a tier may be unavailable. */
  readonly unavailable: readonly { readonly rule: string; readonly why: string }[];
  /** Null when the transaction was refused before simulation. */
  readonly block: number | null;
  readonly at: string;
}

/**
 * Canonical hash of an unsigned transaction.
 *
 * Field order is fixed and values are normalised, so the same transaction
 * always hashes the same way regardless of how the caller happened to build
 * it. Without that, a verdict could not be matched to its record later — which
 * would leave the journal technically immutable and practically useless.
 */
export function hashTransaction(transaction: UnsignedTransaction): string {
  const canonical = [
    transaction.from.toLowerCase(),
    (transaction.to ?? "").toLowerCase(),
    transaction.value.toString(10),
    transaction.data.toLowerCase(),
    String(transaction.chainId),
  ].join("|");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** A fresh salt: 128 random bits, hex. */
export function newSalt(): string {
  return randomBytes(16).toString("hex");
}

/** The commitment a journal entry carries for this transaction and salt. */
export function commitTransaction(transaction: UnsignedTransaction, salt: string): string {
  return createHash("sha256")
    .update(`${salt}|${hashTransaction(transaction)}`, "utf8")
    .digest("hex");
}

export function toEntry(
  transaction: UnsignedTransaction,
  verdict: Verdict,
  salt: string,
): JournalEntry {
  return {
    v: 2,
    txCommitment: commitTransaction(transaction, salt),
    chainId: transaction.chainId,
    tier: verdict.tier,
    rules: [
      ...new Set(
        verdict.findings
          .filter((finding) => finding.severity !== "info")
          .map((finding) => finding.ruleId),
      ),
    ],
    sources: verdict.provenance.sources.map((source) => ({
      id: source.deploymentId,
      lag: source.effectiveLagSeconds,
    })),
    unavailable: verdict.provenance.unavailableRules.map((rule) => ({
      rule: rule.ruleId,
      why: rule.reason,
    })),
    block: verdict.provenance.simulatedAtBlock,
    at: verdict.evaluatedAt,
  };
}

export interface JournalReceipt {
  /** Consensus timestamp assigned by the network, not by us. */
  readonly consensusTimestamp: string;
  readonly topicId: string;
  readonly sequenceNumber: number;
  readonly entry: JournalEntry;
  /** The salt behind `entry.txCommitment`. Hand it to the caller, publish it nowhere. */
  readonly salt: string;
}

export interface VerdictJournal {
  /**
   * Where entries go.
   *
   * On the interface rather than only on the Hedera implementation, because a
   * caller told its verdict was queued rather than written needs to know
   * queued *where* — a promise of a record with no address is not a record.
   */
  readonly topicId: string;
  /** Salt defaults to a fresh one; pass it when the response must cite it before the write lands. */
  record(
    transaction: UnsignedTransaction,
    verdict: Verdict,
    salt?: string,
  ): Promise<JournalReceipt>;
}

/**
 * In-memory journal, for tests and for running without a Hedera account.
 *
 * Deliberately *not* a silent no-op: it keeps entries so a caller can assert
 * on them, and its receipts carry a local timestamp clearly marked as such. A
 * journal that quietly discarded records would let a deployment believe it had
 * an audit trail when it had none.
 */
export class InMemoryVerdictJournal implements VerdictJournal {
  readonly entries: JournalEntry[] = [];
  /** Named so a reader of a response can tell this is not a public record. */
  readonly topicId = "local";
  #sequence = 0;

  record(
    transaction: UnsignedTransaction,
    verdict: Verdict,
    salt: string = newSalt(),
  ): Promise<JournalReceipt> {
    const entry = toEntry(transaction, verdict, salt);
    this.entries.push(entry);
    return Promise.resolve({
      consensusTimestamp: `local-${new Date().toISOString()}`,
      topicId: "local",
      sequenceNumber: ++this.#sequence,
      entry,
      salt,
    });
  }
}
