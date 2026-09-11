/**
 * How a gateway query is paid for.
 *
 * The Graph's gateway takes money two ways. A Studio API key draws on a
 * monthly plan — the cost of a query is real but arrives as a bill later, and
 * nothing in the response says what it was. The x402 endpoint charges per
 * call, and the amount is in the payment itself.
 *
 * That difference is the reason this abstraction exists rather than a boolean.
 * The claim this project makes about its own economics — that the cost of a
 * verdict is a number a caller can see rather than one they take on trust — is
 * only true of the second. Keeping funding a strategy means the client does
 * not care which one is in use, and the ledger below can answer "what did this
 * verdict cost us" for the one that can be answered.
 *
 * Both address a **pinned deployment**, never a subgraph id. The registry
 * advertises only the subgraph-id form of the x402 URL, and taking it would
 * have quietly cost us the property the rest of this package is built on: a
 * subgraph id floats to whatever version its owner publishes next, so a
 * verdict quoting one names something that may already have changed. The
 * deployment-pinned path is undocumented but real, and serves identical terms.
 */

import { x402Client } from "@x402/core/client";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
} from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { privateKeyToAccount } from "viem/accounts";

import type { DeploymentId } from "../types.js";

/** One payment, as it was actually made. */
export interface PaymentRecord {
  readonly deploymentId: DeploymentId;
  /** Smallest unit of the asset, as a string: these are token amounts. */
  readonly amount: string;
  /** Human-readable, e.g. "0.01 USDC". */
  readonly display: string;
  readonly asset: string;
  /** CAIP-2, e.g. `eip155:8453`. */
  readonly network: string;
  readonly paidAt: string;
  /** Settlement reference when the facilitator returned one. */
  readonly transaction: string | null;
}

/**
 * What has been spent, and on what.
 *
 * In memory and per process, which is the right lifetime for the question it
 * answers: a caller asking what a verdict cost is asking about this run, not
 * about an accounting period. Anything durable belongs in a ledger that
 * survives restarts, and inventing one here would imply a completeness this
 * cannot have.
 */
export class PaymentLedger {
  readonly #payments: PaymentRecord[] = [];

  record(payment: PaymentRecord): void {
    this.#payments.push(payment);
  }

  get payments(): readonly PaymentRecord[] {
    return this.#payments;
  }

  /** Number of payments recorded so far, for taking a before/after snapshot. */
  get count(): number {
    return this.#payments.length;
  }

  /** Payments recorded after a given count. */
  since(count: number): readonly PaymentRecord[] {
    return this.#payments.slice(count);
  }

  /**
   * Total spent, per asset.
   *
   * Kept per asset rather than summed into one figure. Adding USDC to HBAR
   * needs an exchange rate, and a rate we invented would turn a measured
   * number into an estimate wearing the same clothes.
   */
  totals(): Readonly<Record<string, string>> {
    const sums = new Map<string, bigint>();
    for (const payment of this.#payments) {
      const key = `${payment.network}:${payment.asset}`;
      sums.set(key, (sums.get(key) ?? 0n) + BigInt(payment.amount));
    }
    return Object.fromEntries([...sums].map(([k, v]) => [k, v.toString()]));
  }
}

/** Where a query goes, how it authenticates, and what it costs. */
export interface GatewayFunding {
  /** Named in provenance, so a reader knows which economics applied. */
  readonly kind: "studio-key" | "x402";
  /** Endpoint for one pinned deployment. */
  url(baseUrl: string, deploymentId: DeploymentId): string;
  /** Headers to add to the request. */
  headers(): Promise<Readonly<Record<string, string>>>;
  /**
   * The fetch to use.
   *
   * For x402 this is wrapped so a 402 is answered with a signed payment and
   * the request retried; for a Studio key it is the plain one.
   */
  readonly fetch: typeof globalThis.fetch;
  /**
   * Send a request whose timeout starts when it is actually sent.
   *
   * Optional: without it the client puts its own timeout around `fetch`.
   * Funding that queues requests implements it, because a timer started
   * before the queue spends itself waiting, and can expire in the middle of a
   * paid retry — the payment settled, the answer thrown away.
   */
  request?(url: string, init: RequestInit, timeoutMs: number): Promise<Response>;
}

/** Draws on a Studio plan. The per-query cost is real but arrives as a bill. */
export class StudioKeyFunding implements GatewayFunding {
  readonly kind = "studio-key" as const;
  readonly fetch: typeof globalThis.fetch;
  readonly #apiKey: () => Promise<string>;

  constructor(apiKey: () => Promise<string>, fetchImpl?: typeof globalThis.fetch) {
    this.#apiKey = apiKey;
    this.fetch = fetchImpl ?? globalThis.fetch;
  }

  url(baseUrl: string, deploymentId: DeploymentId): string {
    return `${baseUrl}/deployments/id/${deploymentId}`;
  }

  async headers(): Promise<Readonly<Record<string, string>>> {
    return { Authorization: `Bearer ${await this.#apiKey()}` };
  }
}

/** Base mainnet, where The Graph's x402 endpoint settles. */
export const BASE_NETWORK = "eip155:8453" as const;

/** Canonical USDC on Base, as the gateway's manifest names it. */
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

/**
 * Ceiling on a single query payment, in USDC's smallest unit.
 *
 * The gateway asks 10_000 (one cent). A cap of 50_000 leaves room for a price
 * change without a redeploy, and keeps a misconfigured or hostile endpoint
 * from emptying the wallet one query at a time. It is set rather than switched
 * off deliberately: an agent that hands over value because something asked it
 * to is the failure this project exists to advise against, and it would be a
 * poor argument to make while doing it ourselves.
 */
export const DEFAULT_MAX_PER_QUERY = "50000";

/**
 * Ceiling on everything one process pays the gateway, in USDC's smallest unit.
 *
 * The per-query cap stops one hostile price and does nothing about a thousand
 * honest ones. A verdict reads a handful of deployments at a cent each, so a
 * dollar is about a hundred queries: ample for a demo run, and a loss someone
 * notices rather than a drain nobody does. Raised deliberately, never by
 * default.
 */
export const DEFAULT_MAX_TOTAL_SPEND = "1000000";

/** Raised before a payment is signed: this process has spent what it may. */
export class GatewaySpendLimitError extends Error {
  constructor(spent: bigint, limit: bigint, asked: bigint) {
    super(
      `paying ${formatUnits6(asked.toString(), "USDC")} would take this process past its gateway ` +
        `spend limit of ${formatUnits6(limit.toString(), "USDC")} ` +
        `(${formatUnits6(spent.toString(), "USDC")} signed so far). Nothing was paid.`,
    );
    this.name = "GatewaySpendLimitError";
  }
}

export interface X402FundingOptions {
  /** Signs EIP-3009 authorisations. A viem LocalAccount satisfies this. */
  readonly signer: {
    readonly address: `0x${string}`;
    signTypedData(message: {
      domain: Record<string, unknown>;
      types: Record<string, unknown>;
      primaryType: string;
      message: Record<string, unknown>;
    }): Promise<`0x${string}`>;
  };
  readonly ledger: PaymentLedger;
  /** Per-payment ceiling, smallest unit. Defaults to {@link DEFAULT_MAX_PER_QUERY}. */
  readonly maxAmountPerQuery?: string;
  /** Ceiling on this process's total, smallest unit. Defaults to {@link DEFAULT_MAX_TOTAL_SPEND}. */
  readonly maxTotalAmount?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
  /**
   * Send one payment at a time. On by default, and only turn it off against a
   * facilitator known to accept concurrent payments from one payer — The
   * Graph's does not.
   */
  readonly serialisePayments?: boolean;
}

/**
 * Pays The Graph per query over x402 on Base.
 *
 * The asset transfer is EIP-3009 `transferWithAuthorization`, which matters
 * more than it sounds: the payment is a *signature*, submitted by the
 * facilitator. The wallet needs USDC and no ETH at all, so the funding
 * question is one asset rather than two, and nothing here ever broadcasts a
 * transaction — consistent with a project whose central claim is that it
 * advises and never signs on anyone's behalf.
 *
 * Amounts are read from the gateway's own 402 manifest rather than assumed
 * from its documentation, and recorded only once settlement comes back. A
 * price we hard-coded would be a number we invented; a payment we logged
 * before it settled would be a cost we might never have paid.
 */
export class X402Funding implements GatewayFunding {
  readonly kind = "x402" as const;
  readonly fetch: typeof globalThis.fetch;
  readonly request: NonNullable<GatewayFunding["request"]>;

  constructor(options: X402FundingOptions) {
    const paying = buildPayingFetch(options);
    this.fetch = paying.fetch;
    this.request = paying.request;
  }

  url(baseUrl: string, deploymentId: DeploymentId): string {
    // Pinned to the deployment, not the subgraph. See the file header.
    return `${baseUrl}/x402/deployments/id/${deploymentId}`;
  }

  headers(): Promise<Readonly<Record<string, string>>> {
    // None: the payment travels in `payment-signature`, added by the wrapper.
    return Promise.resolve({});
  }
}

/** Six-decimal token amount as a readable string, without floating point. */
export function formatUnits6(amount: string, symbol: string): string {
  const value = BigInt(amount);
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${fraction === "" ? whole : `${whole}.${fraction}`} ${symbol}`;
}

/**
 * A fetch that answers 402 with a signed payment, and records what it paid.
 *
 * The observation happens on the *inner* fetch rather than around the wrapper,
 * because that is the only place both halves of the exchange are visible: the
 * 402 carries the manifest with the amount and asset, and only the retried
 * response carries the settlement. Watching from outside would see the price
 * or the receipt but never both.
 *
 * Manifests are keyed by request URL rather than held in a single slot. R3
 * probes deployments concurrently, and one shared slot would attribute one
 * deployment's price to another's payment — a small bug that would corrupt
 * exactly the number this whole path exists to report.
 */
function buildPayingFetch(options: X402FundingOptions): {
  fetch: typeof globalThis.fetch;
  request: NonNullable<GatewayFunding["request"]>;
} {
  const baseFetch = options.fetch ?? globalThis.fetch;
  const serialise = options.serialisePayments ?? true;
  const now = options.now ?? (() => new Date());
  const maxAmount = options.maxAmountPerQuery ?? DEFAULT_MAX_PER_QUERY;
  const maxTotal = BigInt(options.maxTotalAmount ?? DEFAULT_MAX_TOTAL_SPEND);
  const manifests = new Map<string, PaymentRequirementsLike>();
  // Everything signed so far, and what the current turn is signing. Exact
  // with serialised payments, which is the default and the only safe setting
  // against The Graph's gateway.
  let committed = 0n;
  const turn: { signing: bigint | null; refusal: GatewaySpendLimitError | null } = {
    signing: null,
    refusal: null,
  };

  const observing: typeof globalThis.fetch = async (input, init) => {
    const response = await baseFetch(input, init);
    if (response.status === 402) {
      const header = response.headers.get("payment-required");
      if (header !== null) {
        const requirements = firstRequirement(header);
        if (requirements !== null) manifests.set(requestUrl(input), requirements);
      }
    }
    return response;
  };

  const client = new x402Client()
    .setSpendControls({
      allowedAssets: [
        {
          network: BASE_NETWORK,
          asset: BASE_USDC,
          maxAmountPerPayment: maxAmount,
        },
      ],
    })
    .register(`${BASE_NETWORK.split(":")[0]}:*`, new ExactEvmScheme(options.signer))
    .onBeforePaymentCreation(async ({ selectedRequirements }) => {
      const asked = BigInt(selectedRequirements.amount);
      if (committed + asked > maxTotal) {
        turn.refusal = new GatewaySpendLimitError(committed, maxTotal, asked);
        return { abort: true, reason: turn.refusal.message };
      }
      turn.signing = asked;
      return undefined;
    })
    .onAfterPaymentCreation(async () => {
      // Counted at signature. An EIP-3009 authorisation can be settled by
      // whoever holds it, whether or not a settlement header ever comes back.
      if (turn.signing !== null) committed += turn.signing;
      turn.signing = null;
    });

  const pay = wrapFetchWithPayment(observing, client);

  /*
   * Payments go one at a time.
   *
   * The gateway refuses concurrent payments from the same payer: four paid
   * requests in flight together came back as two answers and two bare 402s
   * carrying no error text at all. The rules above are written for queries
   * that cost nothing — R3 probes every candidate deployment in parallel
   * because that is the fastest way to ask — so without this the paid path
   * loses a probe or two per verdict at random and reports `probe_failed`
   * while the wallet is funded and the code is correct.
   *
   * The cost is latency: probes that overlapped now queue, and a verdict over
   * several deployments takes a second or so longer. That is the right trade.
   * A verdict that is slower is a verdict; a verdict assembled from whichever
   * probes happened to win a race is not.
   */
  let queue: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(work: () => Promise<T>): Promise<T> => {
    if (!serialise) return work();
    const result = queue.then(work, work);
    // Kept unrejected so one failed payment does not poison the queue.
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const send = async (
    input: Parameters<typeof globalThis.fetch>[0],
    init: RequestInit | undefined,
    timeoutMs?: number,
  ): Promise<Response> => {
    const url = requestUrl(input);
    const response = await inTurn(async () => {
      turn.refusal = null;
      try {
        // The timer starts here, inside the turn. Started before the queue it
        // spent itself waiting, and could expire during a paid retry that had
        // already settled — an answer paid for and never read.
        return await pay(
          input,
          timeoutMs === undefined ? init : { ...init, signal: AbortSignal.timeout(timeoutMs) },
        );
      } catch (error) {
        // The payment wrapper rewraps what the client throws; the limit is
        // handed back as itself so the reason survives into the verdict.
        const refusal = turn.refusal as GatewaySpendLimitError | null;
        throw refusal ?? error;
      }
    });

    const settlementHeader = response.headers.get("payment-response");
    if (settlementHeader !== null) {
      const settlement = decodePaymentResponseHeader(settlementHeader);
      const manifest = manifests.get(url);
      // Only a settled payment is a cost. A failed settlement means the
      // gateway was not paid, and recording it would overstate what a verdict
      // cost by exactly the amount that never left the wallet.
      if (settlement.success && manifest !== null && manifest !== undefined) {
        options.ledger.record({
          deploymentId: deploymentIdFromUrl(url),
          amount: manifest.amount,
          display: formatUnits6(manifest.amount, "USDC"),
          asset: manifest.asset,
          network: settlement.network ?? manifest.network,
          paidAt: now().toISOString(),
          transaction: settlement.transaction ?? null,
        });
      }
      manifests.delete(url);
    }

    return response;
  };

  return {
    fetch: (input, init) => send(input, init),
    request: (url, init, timeoutMs) => send(url, init, timeoutMs),
  };
}

/**
 * Why the gateway refused a payment, from the 402 it answers with.
 *
 * The second 402 in a paid exchange is a different event from the first, and
 * conflating them costs an operator real time. The first says "this costs
 * money"; the second says "your payment was not accepted", and it names the
 * cause — `invalid_exact_evm_insufficient_balance` for an unfunded wallet,
 * which is a one-line fix pointed at the right place. Without this the caller
 * sees only an unparseable empty body and goes looking for a broken endpoint.
 */
export function paymentRefusalReason(header: string | null): string | null {
  if (header === null) return null;
  try {
    const decoded = decodePaymentRequiredHeader(header) as { error?: unknown };
    return typeof decoded.error === "string" ? decoded.error : null;
  } catch {
    return null;
  }
}

interface PaymentRequirementsLike {
  readonly amount: string;
  readonly asset: string;
  readonly network: string;
}

/**
 * The first payment option the gateway offers.
 *
 * The client's default selector takes the first acceptable entry, so this
 * mirrors it. The Graph advertises exactly one, and if that ever changes the
 * recorded amount would be a guess — which is why the ledger keeps the asset
 * and network alongside, so a wrong guess is visible rather than silent.
 */
function firstRequirement(header: string): PaymentRequirementsLike | null {
  try {
    const decoded = decodePaymentRequiredHeader(header) as {
      accepts?: readonly PaymentRequirementsLike[];
    };
    const first = decoded.accepts?.[0];
    if (first === undefined) return null;
    return { amount: first.amount, asset: first.asset, network: first.network };
  } catch {
    return null;
  }
}

function requestUrl(input: Parameters<typeof globalThis.fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/** Last path segment of a pinned deployment endpoint. */
function deploymentIdFromUrl(url: string): DeploymentId {
  const segments = url.split("?")[0]!.split("/");
  return (segments[segments.length - 1] ?? url) as DeploymentId;
}

export interface FundingChoice {
  readonly funding: GatewayFunding;
  /** One line an operator can read at start-up. */
  readonly reason: string;
}

export interface ChooseFundingOptions {
  /** Studio API key, or null when none is configured. */
  readonly studioKey: string | null;
  /** Base private key that signs payments, or null when none is configured. */
  readonly payerKey: string | null;
  readonly ledger: PaymentLedger;
  /** Force one method. Without it the choice follows what is available. */
  readonly prefer?: "studio-key" | "x402";
  readonly maxAmountPerQuery?: string;
  /** Ceiling on this process's total gateway spend, smallest unit of USDC. */
  readonly maxTotalAmount?: string;
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * Decide how this process pays for gateway queries.
 *
 * The interesting case is the one The Graph's own documentation describes as
 * the reason x402 exists: *you have a funded wallet and no API key, and no
 * human to mint one*. That is not a fallback, it is the agentic path — an
 * agent that needs protocol data at three in the morning cannot open a browser
 * and sign up. So a process with a payer key and no Studio key pays its way
 * rather than refusing to start.
 *
 * Paying is never silent, though, and never the default when a free key would
 * do. Spending real money is a deliberate act; choosing it implicitly on a
 * machine that had a working key would be the same disregard for someone
 * else's funds this project spends its time warning agents about.
 */
export function chooseFunding(options: ChooseFundingOptions): FundingChoice {
  const { studioKey, payerKey, ledger } = options;

  const x402 = (): FundingChoice | null => {
    if (payerKey === null) return null;
    const signer = privateKeyToAccount(normalisePrivateKey(payerKey));
    return {
      funding: new X402Funding({
        signer,
        ledger,
        ...(options.maxAmountPerQuery === undefined
          ? {}
          : { maxAmountPerQuery: options.maxAmountPerQuery }),
        ...(options.maxTotalAmount === undefined ? {} : { maxTotalAmount: options.maxTotalAmount }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      }),
      reason: `paying per query over x402 on Base from ${signer.address}`,
    };
  };

  if (options.prefer === "x402") {
    const chosen = x402();
    if (chosen === null) {
      throw new TypeError("x402 funding was requested but no payer key is configured");
    }
    return chosen;
  }

  if (studioKey !== null && options.prefer !== undefined) {
    return {
      funding: new StudioKeyFunding(() => Promise.resolve(studioKey), options.fetch),
      reason: "using the Studio API key",
    };
  }

  if (studioKey !== null) {
    return {
      funding: new StudioKeyFunding(() => Promise.resolve(studioKey), options.fetch),
      reason: "using the Studio API key (set GATEWAY_FUNDING=x402 to pay per query instead)",
    };
  }

  const chosen = x402();
  if (chosen === null) {
    throw new TypeError("no Studio API key and no payer key: queries cannot be funded");
  }
  return {
    funding: chosen.funding,
    reason: `${chosen.reason} — no Studio key is configured, which is the case x402 exists for`,
  };
}

/** Accepts a key with or without the `0x`, since key exports differ. */
function normalisePrivateKey(raw: string): `0x${string}` {
  const trimmed = raw.trim();
  return (trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`) as `0x${string}`;
}
