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

import {
  newSalt,
  toEntry,
  type JournalEntry,
  type JournalReceipt,
  type VerdictJournal,
} from "./journal.js";

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
  /** The operator's private key as the portal shows it: DER, or 64 hex characters. */
  readonly operatorKey: string;
  /** Reaches the mirror node to learn a raw hex key's type. Injectable for tests. */
  readonly fetch?: typeof globalThis.fetch;
  /** Reuse an existing topic. Omit to create one. */
  readonly topicId?: string;
  /** Written into the topic memo when creating. */
  readonly memo?: string;
}

/**
 * Turn the operator key into the key the operator account actually holds.
 *
 * The portal offers a key as DER, which names its own type, or as 64 raw hex
 * characters, which do not. This used to read raw hex as ECDSA. An ED25519
 * key given that way parsed into a different, perfectly valid ECDSA key, and
 * every journal write then failed with `INVALID_SIGNATURE` — far from the
 * mistake, and easy to blame on the network. So for raw hex the account is
 * asked: the mirror node reports the type it holds and its public key, and
 * the key is accepted only if the two match. The payer resolves agent keys the
 * same way.
 */
export async function resolveOperatorKey(
  raw: string,
  operatorId: string,
  network: HederaNetwork,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<PrivateKey> {
  const trimmed = raw.trim();
  const hex = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;

  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    try {
      return PrivateKey.fromStringDer(trimmed);
    } catch (cause) {
      throw new HcsJournalError(
        "operator key is neither DER nor 64 hex characters; paste it as portal.hedera.com shows it",
        { cause },
      );
    }
  }

  const mirror =
    network === "mainnet"
      ? "https://mainnet.mirrornode.hedera.com"
      : "https://testnet.mirrornode.hedera.com";
  let account: { key?: { _type?: string; key?: string } };
  try {
    const response = await fetchImpl(`${mirror}/api/v1/accounts/${operatorId}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    account = (await response.json()) as typeof account;
  } catch (cause) {
    throw new HcsJournalError(
      `a raw hex key does not say whether it is ECDSA or ED25519, and account ${operatorId} ` +
        `could not be read from the ${network} mirror node to find out ` +
        `(${cause instanceof Error ? cause.message : String(cause)}). Use the key's DER form.`,
      { cause },
    );
  }

  const type = account.key?._type;
  const expected = account.key?.key?.toLowerCase();
  const candidates: PrivateKey[] = [];
  const attempt = (parse: () => PrivateKey) => {
    try {
      candidates.push(parse());
    } catch {
      // Not this type; the error below names what the account holds.
    }
  };
  if (type !== "ED25519") attempt(() => PrivateKey.fromStringECDSA(hex));
  if (type !== "ECDSA_SECP256K1") attempt(() => PrivateKey.fromStringED25519(hex));

  const match =
    expected === undefined
      ? undefined
      : candidates.find((key) => key.publicKey.toStringRaw().toLowerCase() === expected);
  if (match !== undefined) return match;

  throw new HcsJournalError(
    expected === undefined
      ? `account ${operatorId} does not expose a single public key, so a raw hex key cannot be ` +
          "matched to it. Use the key's DER form."
      : `the key is valid but not the one account ${operatorId} holds (${type ?? "unknown type"}). ` +
          "Check that the id and the key come from the same account.",
  );
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
    const key = await resolveOperatorKey(
      options.operatorKey,
      options.operatorId,
      options.network,
      options.fetch,
    );
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
    salt: string = newSalt(),
  ): Promise<JournalReceipt> {
    return this.submit(toEntry(transaction, verdict, salt), salt);
  }

  /** Submit a prepared entry. Separated so callers can journal replays. */
  async submit(entry: JournalEntry, salt: string): Promise<JournalReceipt> {
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
        salt,
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
