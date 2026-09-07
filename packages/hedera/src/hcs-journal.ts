/**
 * Verdict journal backed by the Hedera Consensus Service.
 *
 * Each verdict becomes one topic message. The network assigns the consensus
 * timestamp, which is the property that makes the record worth keeping: we
 * cannot backdate it, and neither can anyone else.
 */

import {
  Client,
  PrivateKey,
  TopicCreateTransaction,
  TopicId,
  TopicMessageSubmitTransaction,
} from "@hashgraph/sdk";

import type { UnsignedTransaction, Verdict } from "@presign/verdict-engine";

import { toEntry, type JournalEntry, type JournalReceipt, type VerdictJournal } from "./journal.js";

export type HederaNetwork = "testnet" | "mainnet";

export class HcsJournalError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(`HCS journal: ${message}`, options);
    this.name = "HcsJournalError";
  }
}

export interface HcsVerdictJournalOptions {
  readonly network: HederaNetwork;
  readonly operatorId: string;
  /** ECDSA private key, hex with or without the `0x` prefix. */
  readonly operatorKey: string;
  /** Reuse an existing topic. Omit to create one. */
  readonly topicId?: string;
  /** Written into the topic memo when creating. */
  readonly memo?: string;
}

/**
 * Accept the key shapes a Hedera portal actually hands out.
 *
 * The portal shows ECDSA keys as `0x`-prefixed hex while the SDK's parser
 * wants them bare, and DER-encoded keys need a different constructor
 * entirely. Guessing wrong produces `INVALID_SIGNATURE` at submit time —
 * far from the mistake, and easy to blame on the network.
 */
function parseOperatorKey(raw: string): PrivateKey {
  const trimmed = raw.trim();
  const hex = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;

  if (/^[0-9a-fA-F]{64}$/.test(hex)) return PrivateKey.fromStringECDSA(hex);

  try {
    return PrivateKey.fromStringDer(trimmed);
  } catch (cause) {
    throw new HcsJournalError(
      "operator key is neither 32-byte hex nor DER; expected the ECDSA key " +
        "shown on portal.hedera.com",
      { cause },
    );
  }
}

export class HcsVerdictJournal implements VerdictJournal {
  readonly topicId: string;
  readonly network: HederaNetwork;
  readonly #client: Client;

  private constructor(client: Client, topicId: string, network: HederaNetwork) {
    this.#client = client;
    this.topicId = topicId;
    this.network = network;
  }

  static async open(
    options: HcsVerdictJournalOptions,
  ): Promise<HcsVerdictJournal> {
    const key = parseOperatorKey(options.operatorKey);
    const client =
      options.network === "mainnet" ? Client.forMainnet() : Client.forTestnet();
    client.setOperator(options.operatorId, key);

    if (options.topicId !== undefined) {
      return new HcsVerdictJournal(client, options.topicId, options.network);
    }

    try {
      const response = await new TopicCreateTransaction()
        .setTopicMemo(options.memo ?? "presign verdict journal")
        // Submit key set to the operator: anyone may read the journal, only we
        // may append to it. A world-writable audit trail proves nothing.
        .setSubmitKey(key.publicKey)
        .execute(client);
      const receipt = await response.getReceipt(client);
      const topicId = receipt.topicId;
      if (topicId === null) {
        throw new HcsJournalError("topic creation returned no topic id");
      }
      return new HcsVerdictJournal(client, topicId.toString(), options.network);
    } catch (cause) {
      if (cause instanceof HcsJournalError) throw cause;
      throw new HcsJournalError(
        `could not create topic: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }
  }

  async record(
    transaction: UnsignedTransaction,
    verdict: Verdict,
  ): Promise<JournalReceipt> {
    const entry = toEntry(transaction, verdict);
    return this.submit(entry);
  }

  /** Submit a prepared entry. Separated so callers can journal replays. */
  async submit(entry: JournalEntry): Promise<JournalReceipt> {
    const payload = JSON.stringify(entry);

    try {
      const response = await new TopicMessageSubmitTransaction()
        .setTopicId(TopicId.fromString(this.topicId))
        .setMessage(payload)
        .execute(this.#client);

      // The record, not just the receipt: the receipt carries the sequence
      // number but the consensus timestamp is the point of the exercise.
      const record = await response.getRecord(this.#client);

      return {
        consensusTimestamp: record.consensusTimestamp.toString(),
        topicId: this.topicId,
        sequenceNumber: record.receipt.topicSequenceNumber?.toNumber() ?? 0,
        entry,
      };
    } catch (cause) {
      throw new HcsJournalError(
        `could not submit entry: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }
  }

  /** Public link to the topic, for a README or a demo. */
  get explorerUrl(): string {
    return `https://hashscan.io/${this.network}/topic/${this.topicId}`;
  }

  close(): void {
    this.#client.close();
  }
}
