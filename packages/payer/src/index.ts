/**
 * @presign/payer
 *
 * Pays for verdicts over x402 on Hedera — the part every consumer of the
 * service would otherwise write for itself, and the part most easily written
 * carelessly.
 *
 * Two consumers share it: the command-line agent and the verdict MCP server.
 * They used to duplicate the key handling and the payment client, which is how
 * a defect gets fixed in one copy and shipped in the other.
 */

import { x402Client } from "@x402/core/client";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { decodePaymentResponseHeader, wrapFetchWithPayment } from "@x402/fetch";
// PrivateKey comes from @x402/hedera rather than @hashgraph/sdk: the x402
// packages build on @hiero-ledger/sdk, the renamed Hedera SDK, and the two
// declare structurally identical but nominally distinct key types. Importing
// from the package that will consume the key avoids the mismatch entirely.
import { createClientHederaSigner, PrivateKey } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";

export { PrivateKey };

export const TINYBARS_PER_HBAR = 100_000_000n;

/** 0.1 HBAR. A metered full verdict costs at most 0.009; this leaves room for a price change. */
export const DEFAULT_MAX_PER_PAYMENT_TINYBARS = 10_000_000n;

/** A decimal HBAR amount as tinybars, without passing through floating point. */
export function hbarToTinybars(hbar: string): bigint {
  const text = hbar.trim();
  if (!/^\d+(\.\d{1,8})?$/.test(text)) {
    throw new RangeError(`not an HBAR amount: ${hbar}`);
  }
  const [whole, fraction = ""] = text.split(".");
  return BigInt(whole!) * TINYBARS_PER_HBAR + BigInt(fraction.padEnd(8, "0"));
}

export function formatTinybars(tinybars: bigint): string {
  const negative = tinybars < 0n;
  const size = negative ? -tinybars : tinybars;
  const whole = size / TINYBARS_PER_HBAR;
  const fraction = (size % TINYBARS_PER_HBAR).toString().padStart(8, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${fraction === "" ? whole : `${whole}.${fraction}`} HBAR`;
}

/**
 * Turn a key string into the key for *this* account, or say exactly why not.
 *
 * The portal offers a key two ways: DER, which names its own type, and 64 raw
 * hex characters, which do not. An earlier version guessed ECDSA for raw hex.
 * An ED25519 key passed that way did not fail — it parsed into a different,
 * perfectly valid ECDSA key with no error at all, and payments would have been
 * signed with a key the account does not hold.
 *
 * So the account is asked. The mirror node reports which key type it holds
 * and the public key itself, the raw hex is read as that type, and the result
 * is accepted only if its public key matches. That also turns the commonest
 * mistake — an id and a key copied from two different accounts — from an
 * error about bytes into a sentence naming the account.
 */
export async function resolveKey(
  raw: string,
  accountId: string,
  network: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<PrivateKey> {
  const mirror =
    network === "hedera:mainnet"
      ? "https://mainnet.mirrornode.hedera.com"
      : "https://testnet.mirrornode.hedera.com";

  const response = await fetchImpl(`${mirror}/api/v1/accounts/${accountId}`);
  if (!response.ok) {
    throw new Error(
      `could not read account ${accountId} from the ${network} mirror node (HTTP ${response.status}) — ` +
        "check the account id",
    );
  }
  const account = (await response.json()) as { key?: { _type?: string; key?: string } };
  const type = account.key?._type;
  const expected = account.key?.key?.toLowerCase();

  const hex = raw.startsWith("0x") ? raw.slice(2) : raw;
  const candidates: PrivateKey[] = [];
  const attempt = (parse: () => PrivateKey) => {
    try {
      candidates.push(parse());
    } catch {
      // Not this format; the message below says what was expected.
    }
  };

  if (/^[0-9a-fA-F]{64}$/.test(hex)) {
    // Raw bytes carry no type. Read them as whatever the account holds, and
    // only try both when the account does not say.
    if (type === "ED25519") attempt(() => PrivateKey.fromStringED25519(hex));
    else if (type === "ECDSA_SECP256K1") attempt(() => PrivateKey.fromStringECDSA(hex));
    else {
      attempt(() => PrivateKey.fromStringECDSA(hex));
      attempt(() => PrivateKey.fromStringED25519(hex));
    }
  } else {
    attempt(() => PrivateKey.fromStringDer(hex));
  }

  if (candidates.length === 0) {
    throw new Error(
      "the key does not contain a private key. Paste it exactly as the portal shows it: " +
        `the DER form (starts 302e… or 3030…) or 64 hex characters. It has ${raw.length} characters.`,
    );
  }

  // A threshold key or key list has no single public key to compare against.
  // Proceed, but say the match could not be checked rather than implying it was.
  if (expected === undefined) {
    console.warn(
      `  note: account ${accountId} does not expose a single public key; the key was not verified against it`,
    );
    return candidates[0]!;
  }

  const match = candidates.find((key) => key.publicKey.toStringRaw().toLowerCase() === expected);
  if (match !== undefined) return match;

  throw new Error(
    `the key is valid but not the one account ${accountId} holds (${type ?? "unknown type"}). ` +
      "Check that the id and the key were copied from the same account.",
  );
}

/** Raised before a payment is signed, never after: nothing left the wallet. */
export class BudgetExceededError extends Error {
  readonly spent: bigint;
  readonly budget: bigint;
  readonly asked: bigint;

  constructor(spent: bigint, budget: bigint, asked: bigint) {
    super(
      `paying ${formatTinybars(asked)} would take this session to ${formatTinybars(spent + asked)}, ` +
        `past its budget of ${formatTinybars(budget)}. Nothing was paid.`,
    );
    this.name = "BudgetExceededError";
    this.spent = spent;
    this.budget = budget;
    this.asked = asked;
  }
}

export interface Payment {
  readonly amount: bigint;
  readonly transaction: string | null;
  readonly paidAt: string;
}

export interface PayerOptions {
  readonly accountId: string;
  readonly privateKey: PrivateKey;
  /** CAIP-2, e.g. `hedera:testnet`. */
  readonly network: string;
  /** Ceiling on any single payment. Defaults to 0.1 HBAR. */
  readonly maxPerPaymentTinybars?: bigint;
  /**
   * Ceiling on everything this payer spends, across all calls.
   *
   * Omit for a one-shot program. Set it whenever a model decides when to pay:
   * a tool that pays per call, invoked in a loop, empties a wallet one cent at
   * a time, and nothing in the per-payment ceiling notices.
   */
  readonly sessionBudgetTinybars?: bigint;
  readonly fetch?: typeof globalThis.fetch;
}

export interface Payer {
  /** A fetch that answers 402 with a signed payment and records what it paid. */
  readonly fetch: typeof globalThis.fetch;
  readonly spent: bigint;
  readonly budget: bigint | null;
  /** Null when there is no session budget. */
  readonly remaining: bigint | null;
  readonly payments: readonly Payment[];
}

/** Whether a 402 carries payment requirements that could be read at all. */
function priceReadable(header: string | null): boolean {
  if (header === null) return false;
  try {
    const decoded = decodePaymentRequiredHeader(header) as { accepts?: readonly unknown[] };
    return (decoded.accepts?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

export function createPayer(options: PayerOptions): Payer {
  const baseFetch = options.fetch ?? globalThis.fetch;
  const maxPerPayment = options.maxPerPaymentTinybars ?? DEFAULT_MAX_PER_PAYMENT_TINYBARS;
  const budget = options.sessionBudgetTinybars ?? null;
  const payments: Payment[] = [];
  let spent = 0n;
  // What the current turn is about to sign, and why it refused, if it did.
  const turn: { signing: bigint | null; refusal: BudgetExceededError | null } = {
    signing: null,
    refusal: null,
  };

  /*
   * A price that cannot be read is refused when a budget is set. Paying
   * without knowing the amount is exactly the case a budget exists to stop.
   */
  const observing: typeof globalThis.fetch = async (input, init) => {
    const response = await baseFetch(input, init);
    if (
      response.status === 402 &&
      budget !== null &&
      !priceReadable(response.headers.get("payment-required"))
    ) {
      throw new Error(
        "the service asked for payment but its price could not be read; refusing to pay an unknown amount",
      );
    }
    return response;
  };

  const signer = createClientHederaSigner(options.accountId, options.privateKey, {
    network: options.network,
  } as never);

  const client = new x402Client()
    .setSpendControls({
      allowedAssets: [
        {
          network: options.network as `${string}:${string}`,
          asset: "0.0.0",
          maxAmountPerPayment: maxPerPayment.toString(),
        },
      ],
    })
    .register("hedera:*", new ExactHederaScheme(signer))
    /*
     * The budget is checked against the requirement the client actually chose,
     * before anything is signed.
     *
     * It used to read the first entry of the 402's list. The client pays the
     * first entry it *can* pay, after dropping networks it has no scheme for
     * and amounts past its per-payment ceiling — so a service listing a cheap
     * option on another chain ahead of a dear one in HBAR had the cheap one
     * checked and the dear one paid.
     */
    .onBeforePaymentCreation(async ({ selectedRequirements }) => {
      const asked = BigInt(selectedRequirements.amount);
      if (budget !== null && spent + asked > budget) {
        turn.refusal = new BudgetExceededError(spent, budget, asked);
        return { abort: true, reason: turn.refusal.message };
      }
      turn.signing = asked;
      return undefined;
    })
    /*
     * Spend is counted when the payment is signed, not when a settlement
     * header comes back. A signed transfer can be submitted by whoever holds
     * it, and a service that settles and then omits the header, or says it
     * failed, must not leave the budget where it was.
     */
    .onAfterPaymentCreation(async () => {
      if (turn.signing !== null) spent += turn.signing;
    });

  const pay = wrapFetchWithPayment(observing, client);

  /*
   * One payment at a time. The budget check and the spend it guards must not
   * interleave: two concurrent calls could each see room for one more payment
   * and both pay, leaving the session past the budget it was meant to hold.
   */
  let queue: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(work, work);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const paying: typeof globalThis.fetch = (input, init) =>
    inTurn(async () => {
      turn.signing = null;
      turn.refusal = null;
      let response: Response;
      try {
        response = await pay(input, init);
      } catch (error) {
        // The payment wrapper rewraps whatever the client throws. A spent
        // budget is handed back as itself, so a caller can tell it from a fault.
        const refusal = turn.refusal as BudgetExceededError | null;
        throw refusal ?? error;
      }
      const signed = turn.signing as bigint | null;
      const header = response.headers.get("payment-response");
      if (header !== null && signed !== null) {
        const settled = decodePaymentResponseHeader(header) as {
          success?: boolean;
          transaction?: string;
        };
        // The list of payments is what settled; the budget above already
        // counted what was signed.
        if (settled.success === true) {
          payments.push({
            amount: signed,
            transaction: settled.transaction ?? null,
            paidAt: new Date().toISOString(),
          });
        }
      }
      return response;
    });

  return {
    fetch: paying,
    get spent() {
      return spent;
    },
    budget,
    get remaining() {
      return budget === null ? null : budget - spent;
    },
    get payments() {
      return payments;
    },
  };
}
