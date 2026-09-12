/**
 * x402-gated verdict service.
 *
 * An agent asks for a verdict on an unsigned transaction and pays for it per
 * call, in HBAR, with no API key and no account. The price is quoted before
 * payment and the actual consumption is reported after, so the cost of a
 * verdict is a number the caller can see rather than a figure they have to
 * trust.
 *
 * Two priced routes rather than one. `/verdict/local` runs the rules that need
 * only an RPC; `/verdict/full` adds R3, which buys indexed protocol data from a
 * metered gateway, and R4, which asks the deployment registry whether anyone
 * has ever indexed the counterparty at all. Charging both the same would make cheap callers subsidise
 * expensive ones and would hide the only cost in the system that scales.
 *
 * The dearer route is registered **only** when a pipeline that can actually run
 * R3 is supplied. An earlier version always exposed it while the process was
 * wired with R1 and R2 alone, so a caller paying five times the price received
 * exactly the cheaper verdict. Taking money for work the process cannot perform
 * is the worst failure available to a service that sells honesty, and a comment
 * saying so did not prevent it — the types now do.
 */

import { createHash } from "node:crypto";

import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { formatUnits6, type PaymentLedger } from "@presign/operational-layer";
import { paymentMiddleware, setSettlementOverrides } from "@x402/hono";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { ExactHederaScheme } from "@x402/hedera/exact/server";

import type { PresignPipeline } from "@presign/gateway";
import { commitTransaction, newSalt, type VerdictJournal } from "@presign/hedera";
import { LruMap, type UnsignedTransaction, type Verdict } from "@presign/verdict-engine";

import {
  parseRules,
  quote,
  formatHbar,
  BASE_TINYBARS,
  INDEXED_DATA_TINYBARS,
  MAX_PRICED_DEPLOYMENTS,
  PER_DEPLOYMENT_TINYBARS,
  type Meter,
  type Quote,
  type RuleId,
} from "./pricing.js";
import { createRateLimiter } from "./rate-limit.js";
import type { DemoExample } from "./demo.js";

export type HederaNetwork = "hedera:testnet" | "hedera:mainnet";

/**
 * Blocky402 settles both Hedera networks, from separate hosts.
 *
 * The split is easy to misread. `api.blocky402.com/supported` lists
 * `hedera:mainnet` alone, which looks like "Blocky402 is mainnet-only" — and
 * this service settled testnet through x402.org for a while on exactly that
 * reading. Testnet has its own host, open access and its own fee payer.
 * Pointing a network at a host that does not list it fails at startup sync
 * rather than with a clear message, so the mapping is explicit here.
 */
export const FACILITATORS: Readonly<Record<HederaNetwork, string>> = {
  "hedera:testnet": "https://api.testnet.blocky402.com",
  "hedera:mainnet": "https://api.blocky402.com",
};

export interface ServicePipelines {
  /** R1 and R2: simulation and local checks. Always required. */
  readonly local: PresignPipeline;
  /**
   * R1 through R4. Omit when indexed data is unavailable — the `/verdict/full`
   * route is then not registered at all, so it cannot be paid for.
   */
  readonly full?: PresignPipeline;
}

/**
 * Anything whose liveness an operator needs to see without buying a verdict.
 *
 * The proxy upgrade stream is the first: while it is backfilling or after it
 * has died, R2 reports upgrade history as unavailable rather than clean. That
 * is the correct behaviour, and it is also invisible from outside unless the
 * service says so — an operator should not have to pay for a verdict to
 * discover that a data source stopped.
 */
export interface HealthSource {
  readonly name: string;
  readonly live: boolean;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface ServiceOptions {
  readonly pipelines: ServicePipelines;
  /** Reported by /health. Evaluated per request, not cached. */
  readonly sources?: () => readonly HealthSource[];
  /**
   * Whether a verdict could be produced right now, asked on every /health.
   *
   * Without it /health answered ok: true whatever had died, so a container
   * healthcheck stayed green while anvil was gone and every verdict was a 503.
   */
  readonly ready?: () => Promise<{ ok: boolean; detail?: string }>;
  readonly journal: VerdictJournal;
  /** Hedera account that receives payment. */
  readonly payTo: string;
  readonly network: HederaNetwork;
  /**
   * Chains this instance can simulate: the fork's own, read from the fork.
   *
   * Required so a deployment cannot leave it out. Before it existed a
   * transaction for any chain was accepted, paid for and simulated against
   * Ethereum state, and USDC on Base came back `low`.
   */
  readonly chainIds: readonly number[];
  /**
   * Prices /verdict/full by the deployments it will read, counted before the
   * 402. Omit for the flat price.
   */
  readonly meter?: Meter;
  /** New counterparties one client may price per minute. Defaults to 30. */
  readonly meterRequestsPerMinute?: number;
  /** Override the facilitator, e.g. a self-hosted one. */
  readonly facilitatorUrl?: string;
  /**
   * What this service paid upstream, when it funds queries with x402.
   *
   * Present only when the process pays per query. Absent means the gateway is
   * funded by a Studio plan, where the marginal cost of a query is real but
   * arrives on a monthly invoice — so the honest report is that the number is
   * unknown here, not that it is zero.
   */
  readonly ledger?: PaymentLedger;
  /**
   * The landing page's live examples. Omit and the routes do not exist.
   *
   * Free, and bounded by construction rather than by a rate limit somebody has
   * to trust: a fixed set of transactions, a fixed set of budgets, one cached
   * answer per pair.
   */
  readonly demo?: DemoOptions;
}

export interface DemoOptions {
  readonly examples: readonly DemoExample[];
  /** Freshness budgets a caller may ask for, in seconds. */
  readonly budgets: readonly number[];
  readonly evaluate: (
    transaction: UnsignedTransaction,
    budgetSeconds: number,
  ) => Promise<Verdict>;
  /** How long one answer is reused. Defaults to 45 seconds. */
  readonly ttlSeconds?: number;
  readonly now?: () => number;
}

/**
 * The request as the public saw it, not as the proxy relayed it.
 *
 * The service speaks plain HTTP behind a TLS proxy, so every URL Hono sees
 * begins `http://` — including the one the x402 middleware copies into the
 * payment manifest, which then advertised an `http` endpoint for a service
 * whose own broker refuses anything but `https`. Only an upgrade is honoured:
 * a forged header can claim the scheme the proxy already uses and nothing else.
 */
export function publicRequest(request: Request): Request {
  const forwarded = request.headers.get("x-forwarded-proto");
  const scheme = forwarded === null ? null : forwarded.split(",")[0]!.trim();
  if (scheme !== "https" || !request.url.startsWith("http://")) return request;
  return new Request(`https://${request.url.slice("http://".length)}`, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    signal: request.signal,
    // Node needs this whenever a streamed body is passed along.
    duplex: "half",
  } as RequestInit);
}

/**
 * Upstream spend attributable to one verdict.
 *
 * Returns a stated unknown rather than zero when there is no ledger. A `0`
 * there would read as "this verdict cost us nothing", which is false on a
 * Studio plan — the cost is simply somewhere this process cannot see.
 */
function describeUpstream(ledger: PaymentLedger | undefined, mark: number) {
  if (ledger === undefined) {
    return {
      funding: "studio-key",
      known: false,
      note: "queries are funded by a Studio plan, so their marginal cost is billed monthly rather than per call",
    };
  }
  const payments = ledger.since(mark);
  return {
    funding: "x402",
    known: true,
    queries_paid: payments.length,
    total: payments.length === 0 ? "0 USDC" : formatUnits6(
      payments.reduce((sum, p) => sum + BigInt(p.amount), 0n).toString(),
      "USDC",
    ),
    payments: payments.map((p) => ({
      deployment_id: p.deploymentId,
      amount: p.display,
      network: p.network,
      transaction: p.transaction,
    })),
  };
}

/** How the caller wants the verdict journalled. */
export type JournalMode = "sync" | "async";

/**
 * Read the caller's journalling preference.
 *
 * Two chain operations sit in the path of a paid verdict — the payment and the
 * journal entry — and neither depends on the other, so making the caller wait
 * for both costs about two seconds that some callers would rather not spend.
 * Others would rather have the receipt: somebody preparing for a dispute needs
 * a sequence number they can cite, not a promise that one is coming.
 *
 * There is no right answer to pick on their behalf, so it is a parameter.
 * `sync` stays the default because it is what this service already promised,
 * and quietly turning an assurance into an intention is not an upgrade.
 */
export function parseJournalMode(raw: string | undefined): JournalMode {
  if (raw === undefined || raw === "") return "sync";
  if (raw === "sync" || raw === "async") return raw;
  throw new RangeError(`journal must be "sync" or "async", not ${raw}`);
}

interface VerdictRequestBody {
  readonly transaction?: {
    from?: string;
    to?: string | null;
    value?: string;
    data?: string;
    chainId?: number;
  };
}

/** The slice of the x402 request context a price function reads. */
type PricingContext = { readonly adapter: { getBody?(): unknown } };

/** A fixed price, or one computed from the request being paid for. */
type RoutePrice = bigint | ((context: PricingContext) => Promise<bigint>);

/** Raised when a client has priced too many new counterparties this minute. */
class RateLimitedError extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super("rate_limited");
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX = /^0x([0-9a-fA-F]{2})*$/;
const DECIMAL = /^\d+$/;

/** 128 KiB of calldata: more than any single transaction a block would carry. */
const MAX_CALLDATA_BYTES = 128 * 1024;
/** Hex doubles the calldata; the JSON around it is small. */
const MAX_BODY_BYTES = 2 * MAX_CALLDATA_BYTES + 64 * 1024;

/** Reject a malformed transaction before charging for it. */
function parseTransaction(body: VerdictRequestBody): UnsignedTransaction {
  const raw = body.transaction;
  if (raw === undefined) throw new RangeError("body.transaction is required");
  if (typeof raw.from !== "string") throw new RangeError("transaction.from is required");
  if (typeof raw.data !== "string") throw new RangeError("transaction.data is required");
  if (typeof raw.chainId !== "number") throw new RangeError("transaction.chainId is required");

  // Format after presence, so a missing field is named before a malformed one.
  if (!ADDRESS.test(raw.from)) {
    throw new RangeError("transaction.from must be a 0x-prefixed 20-byte address");
  }
  if (typeof raw.to === "string" && !ADDRESS.test(raw.to)) {
    throw new RangeError("transaction.to must be a 0x-prefixed 20-byte address, or null");
  }
  if (!HEX.test(raw.data)) throw new RangeError("transaction.data must be 0x-prefixed hex");
  if (raw.data.length > 2 + 2 * MAX_CALLDATA_BYTES) {
    throw new RangeError(`transaction.data exceeds ${MAX_CALLDATA_BYTES} bytes`);
  }
  if (raw.value !== undefined && !(typeof raw.value === "string" && DECIMAL.test(raw.value))) {
    throw new RangeError("transaction.value must be a decimal string of wei");
  }

  return {
    from: raw.from as never,
    to: (raw.to ?? null) as never,
    value: BigInt(raw.value ?? "0"),
    data: raw.data as never,
    chainId: raw.chainId,
  };
}

/** The service app, plus a way to let asynchronous journal writes finish. */
export interface PresignApp extends Hono {
  /** Resolves when no asynchronous journal write is outstanding, or on timeout. */
  drainJournal(timeoutMs?: number): Promise<void>;
}

export function createApp(options: ServiceOptions): PresignApp {
  /*
   * Journal writes that failed after their response had already gone out.
   * Counted because an asynchronous write has nobody left to tell: the caller
   * is gone, and without this the record could stop being written while every
   * response went on looking exactly as healthy as before.
   */
  let journalFailures = 0;
  /*
   * Asynchronous journal writes still in flight.
   *
   * They outlive the response that returned `queued`, so on shutdown they are
   * the one piece of state nobody else holds: the caller has their salt and
   * the entry is not on the topic yet.
   */
  const pendingWrites = new Set<Promise<void>>();

  const app = new Hono();

  const facilitatorUrl = options.facilitatorUrl ?? FACILITATORS[options.network];
  const facilitator = new HTTPFacilitatorClient({ url: facilitatorUrl });
  const server = new x402ResourceServer(facilitator).register(
    "hedera:*",
    // HBAR rather than USDC: an agent that has just been funded has HBAR for
    // fees anyway, so paying in the same asset removes a token association
    // step that has nothing to do with what is being bought.
    new ExactHederaScheme({
      defaultAssets: {
        "hedera:testnet": { asset: "0.0.0", decimals: 8 },
        "hedera:mainnet": { asset: "0.0.0", decimals: 8 },
      },
    }),
  );

  const fullAvailable = options.pipelines.full !== undefined;

  /**
   * Free: what a verdict would cost, before committing to buy one.
   *
   * Advertises only routes this process can serve, so the quote and the
   * registered routes cannot drift apart.
   */
  const limiter = createRateLimiter({ perMinute: options.meterRequestsPerMinute ?? 30 });

  /**
   * Who is asking. Behind the reverse proxy the peer is always the proxy, so
   * the first X-Forwarded-For hop is the client. Without a proxy there is no
   * header and every caller shares one allowance, which errs toward refusing.
   */
  const clientOf = (forwardedFor: string | undefined) =>
    forwardedFor?.split(",")[0]?.trim() || "direct";

  /** Counting deployments costs work; a price already held does not, and is never limited. */
  const admitCount = (transaction: UnsignedTransaction, client: string) => {
    if (options.meter === undefined || options.meter.peek(transaction) !== undefined) return;
    const taken = limiter.take(client);
    if (!taken.ok) throw new RateLimitedError(taken.retryAfterSeconds);
  };

  const tooMany = (c: Context, error: RateLimitedError) => {
    c.header("Retry-After", String(error.retryAfterSeconds));
    return c.json(
      {
        error: "rate_limited",
        message:
          "Too many new counterparties priced from this client in the last minute. " +
          "Prices already quoted are still served.",
        retry_after_seconds: error.retryAfterSeconds,
      },
      429,
    );
  };

  /** `GET /quote?to=0x…`: what a full verdict about this counterparty costs. */
  const quoteForCounterparty = async (
    to: string | undefined,
    chain: string | undefined,
    client: string,
  ) => {
    if (to === undefined || options.meter === undefined || !fullAvailable) return undefined;
    if (!/^0x[0-9a-fA-F]{40}$/.test(to)) {
      throw new RangeError("to must be a 0x-prefixed 20-byte address");
    }
    // `Number("abc")` is NaN, which priced as a chain with nothing indexed.
    if (chain !== undefined && (!/^\d{1,10}$/.test(chain) || !options.chainIds.includes(Number(chain)))) {
      throw new RangeError(`chain_id must be one this instance serves: ${options.chainIds.join(", ")}`);
    }
    const chainId = chain === undefined ? options.chainIds[0]! : Number(chain);
    const transaction = {
      from: "0x0000000000000000000000000000000000000000",
      to,
      value: 0n,
      data: "0x",
      chainId,
    } as unknown as UnsignedTransaction;
    admitCount(transaction, client);
    const priced = await options.meter.quote(transaction);
    return {
      route: "/verdict/full",
      to: to.toLowerCase(),
      chain_id: chainId,
      hbar: priced.hbar,
      tinybars: priced.tinybars.toString(),
      deployments: priced.deployments,
      breakdown: priced.breakdown,
    };
  };

  const fullRange = `${formatHbar(BASE_TINYBARS)}–${formatHbar(
    BASE_TINYBARS + PER_DEPLOYMENT_TINYBARS * BigInt(MAX_PRICED_DEPLOYMENTS),
  )}`;

  /**
   * The top-level price, for the rules asked about.
   *
   * A flat figure here said 0.005 while the route that runs those rules was
   * metered at 0.001–0.009: two prices for one verdict in one response. When
   * the rules asked about are metered, this says so and gives the range; the
   * exact figure for one counterparty comes from `?to=`.
   */
  const requestedPrice = (rules: readonly RuleId[]) => {
    const metered =
      options.meter !== undefined && fullAvailable && rules.some((rule) => rule === "R3" || rule === "R4");
    if (!metered) {
      const flat = quote(rules);
      return { ...flat, tinybars: flat.tinybars.toString() };
    }
    return {
      rules,
      pricing: "metered",
      hbar: fullRange,
      tinybars: null,
      breakdown: [
        { item: "simulation, R1, R2 and R4", tinybars: BASE_TINYBARS.toString() },
        {
          item: `indexed data (R3): ${formatHbar(PER_DEPLOYMENT_TINYBARS)} HBAR per deployment read, at most ${MAX_PRICED_DEPLOYMENTS}`,
          tinybars: null,
        },
      ],
    };
  };

  app.get("/quote", async (c) => {
    try {
      const rules = parseRules(c.req.query("rules"));
      const quoteFor = await quoteForCounterparty(
        c.req.query("to"),
        c.req.query("chain_id"),
        clientOf(c.req.header("x-forwarded-for")),
      );
      const routes: Record<string, unknown> = {
        "/verdict/local": {
          rules: ["R1", "R2"],
          hbar: formatHbar(BASE_TINYBARS),
          buys: "simulation, approval and proxy-mutability checks",
        },
      };
      if (fullAvailable) {
        routes["/verdict/full"] = {
          rules: ["R1", "R2", "R3", "R4"],
          ...(options.meter === undefined
            ? { hbar: formatHbar(BASE_TINYBARS + INDEXED_DATA_TINYBARS) }
            : {
                pricing: "metered",
                hbar: fullRange,
                base_hbar: formatHbar(BASE_TINYBARS),
                per_deployment_hbar: formatHbar(PER_DEPLOYMENT_TINYBARS),
                max_priced_deployments: MAX_PRICED_DEPLOYMENTS,
                how:
                  "The base price plus one unit per indexed deployment R3 will read for this " +
                  "counterparty, counted before payment. GET /quote?to=<address> prices one.",
              }),
          buys:
            "the above, plus protocol invariants from freshness-gated indexed data " +
            "and identification of the counterparty against the deployment registry",
        };
      }
      return c.json({
        network: options.network,
        pay_to: options.payTo,
        chain_ids: options.chainIds,
        facilitator: facilitatorUrl,
        asset: "HBAR",
        ...requestedPrice(rules),
        routes,
        ...(quoteFor === undefined ? {} : { quote_for: quoteFor }),
        ...(fullAvailable
          ? {}
          : {
              note: "This instance has no indexed-data source configured, so R3 and R4 cannot run and /verdict/full is not offered. /verdict/local therefore says nothing about whether the counterparty is a contract anyone has ever indexed.",
            }),
      });
    } catch (error) {
      if (error instanceof RateLimitedError) return tooMany(c, error);
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  app.get("/health", async (c) => {
    /*
     * `ok` is a claim about whether a verdict can be produced right now, not
     * about the process having started. The probe asks the fork, without which
     * nothing else matters; data sources stay informational, because a rule
     * reporting its data unavailable is a working service refusing to guess.
     */
    const ready = (await options.ready?.()) ?? { ok: true };
    return c.json({
      ok: ready.ok,
      ...(ready.detail === undefined ? {} : { not_ready: ready.detail }),
      network: options.network,
      payTo: options.payTo,
      facilitator: facilitatorUrl,
      // Transactions for any other chain are refused before payment.
      chain_ids: options.chainIds,
      rules: fullAvailable ? ["R1", "R2", "R3", "R4"] : ["R1", "R2"],
      // What this process has spent upstream since it started, so an operator
      // can see the running cost without buying a verdict to find out.
      journal: {
        topic: options.journal.topicId,
        // Zero is the expected reading. Anything else means entries were lost
        // after their response had already been sent.
        failed_async_writes: journalFailures,
        pending_async_writes: pendingWrites.size,
      },
      upstream_spend:
        options.ledger === undefined
          ? { funding: "studio-key", known: false }
          : {
              funding: "x402",
              known: true,
              queries_paid: options.ledger.count,
              totals: options.ledger.totals(),
            },
      sources: (options.sources?.() ?? []).map((source) => ({
        name: source.name,
        live: source.live,
        ...(source.detail ?? {}),
      })),
    }, ready.ok ? 200 : 503);
  });

  /*
   * The landing page's live examples.
   *
   * Three fixed transactions, a handful of freshness budgets, and one answer
   * cached per pair for a minute: a thousand readers cost the gateway what two
   * do. When a refresh fails — the fork gone, a probe unreachable — the last
   * real answer is served with its age rather than an error, which is the same
   * rule this service sells applied to its own output: say how old the
   * evidence is and let the reader judge it.
   */
  const demo = options.demo;
  if (demo !== undefined) {
    const demoTtl = (demo.ttlSeconds ?? 45) * 1000;
    const demoNow = demo.now ?? Date.now;
    type DemoAnswer = { verdict: Verdict; computedAt: number; holdMs: number };
    const answers = new LruMap<string, DemoAnswer>(64);
    const running = new Map<string, Promise<DemoAnswer>>();

    /*
     * How long an answer is worth reusing depends on why it says what it says.
     *
     * `unavailable` because every deployment is past the freshness budget is
     * the product working, and is held like any other answer. `unavailable`
     * because a probe timed out is a fault of the moment, and holding it for a
     * minute left the page showing a failure long after the service had
     * recovered — a wider budget reading `unavailable` while a narrower one
     * answered, which is the opposite of what the slider is there to show.
     */
    const TRANSIENT = new Set(["probe_failed", "query_failed", "rule_error"]);
    const holdFor = (verdict: Verdict) =>
      verdict.provenance.unavailableRules.some((rule) => TRANSIENT.has(rule.reason))
        ? Math.min(demoTtl, 8_000)
        : demoTtl;
    const demoLimiter = createRateLimiter({ perMinute: 60 });

    const described = (example: DemoExample) => ({
      id: example.id,
      title: example.title,
      detail: example.detail,
      budget_matters: example.budgetMatters,
      transaction: {
        from: example.transaction.from,
        to: example.transaction.to,
        value: example.transaction.value.toString(),
        data: example.transaction.data,
        chain_id: example.transaction.chainId,
      },
    });

    app.get("/demo/examples", (c) =>
      c.json({
        budgets: demo.budgets,
        default_budget: demo.budgets[demo.budgets.length - 1],
        examples: demo.examples.map(described),
        note: "Fixed examples, evaluated live on this instance. Agents send their own transactions to the paid routes; see /llms.txt.",
      }),
    );

    app.get("/demo/verdict", async (c) => {
      const example = demo.examples.find((entry) => entry.id === c.req.query("example"));
      if (example === undefined) {
        return c.json(
          {
            error: "unknown_example",
            message: "This endpoint answers for a fixed set of transactions.",
            examples: demo.examples.map((entry) => entry.id),
          },
          404,
        );
      }

      const asked = c.req.query("budget");
      const budget =
        asked === undefined ? demo.budgets[demo.budgets.length - 1]! : Number(asked);
      if (!demo.budgets.includes(budget)) {
        return c.json(
          { error: "unsupported_budget", message: "Freshness budgets are fixed.", budgets: demo.budgets },
          400,
        );
      }

      const taken = demoLimiter.take(clientOf(c.req.header("x-forwarded-for")));
      if (!taken.ok) {
        c.header("Retry-After", String(taken.retryAfterSeconds));
        return c.json(
          { error: "rate_limited", retry_after_seconds: taken.retryAfterSeconds },
          429,
        );
      }

      const key = `${example.id}:${budget}`;
      const held = answers.get(key);
      let answer = held !== undefined && demoNow() - held.computedAt < held.holdMs ? held : undefined;
      let staleBecause: string | null = null;

      if (answer === undefined) {
        let pending = running.get(key);
        if (pending === undefined) {
          pending = demo
            .evaluate(example.transaction, budget)
            .then((verdict) => ({ verdict, computedAt: demoNow(), holdMs: holdFor(verdict) }));
          running.set(key, pending);
          void pending.then(
            () => running.delete(key),
            () => running.delete(key),
          );
        }
        try {
          answer = await pending;
          answers.set(key, answer);
        } catch (error) {
          // A verdict of `unavailable` is an answer and lands above. This is
          // the other case: nothing could be evaluated at all.
          if (held === undefined) {
            return c.json(
              {
                error: "demo_unavailable",
                message: "This instance could not evaluate the example just now, and has no earlier answer to show.",
                detail: error instanceof Error ? error.message : String(error),
              },
              503,
            );
          }
          answer = held;
          staleBecause = error instanceof Error ? error.message : String(error);
        }
      }

      const ageSeconds = Math.max(0, Math.round((demoNow() - answer.computedAt) / 100) / 10);
      return c.json({
        example: described(example),
        budget_seconds: budget,
        verdict: answer.verdict,
        // The page states the age of its own answer, which is the whole claim
        // this service makes about anybody else's.
        computed: {
          at: new Date(answer.computedAt).toISOString(),
          age_seconds: ageSeconds,
          ...(staleBecause === null ? {} : { could_not_refresh: staleBecause }),
        },
      });
    });
  }

  /** One payment option per route: HBAR on the configured network. */
  const hbarAmount = (tinybars: bigint) => ({ asset: "0.0.0", amount: tinybars.toString() });

  const accepts = (price: RoutePrice) => ({
    scheme: "exact",
    payTo: options.payTo,
    // Quoted as an explicit asset amount rather than a dollar figure, so the
    // charge does not move with an exchange rate between quote and payment.
    // HBAR amounts are in tinybars.
    price:
      typeof price === "bigint"
        ? hbarAmount(price)
        : async (context: PricingContext) => hbarAmount(await price(context)),
    network: options.network,
  });

  /*
   * The full verdict is metered when a meter is supplied.
   *
   * A Hedera `exact` payment is a transfer signed for a fixed amount, so the
   * amount cannot be trimmed after the verdict runs; the only honest metering
   * is to count what the verdict will read before asking for payment. The
   * validation middleware has already rejected a malformed body by the time
   * this runs, so parsing it here cannot fail on the caller's input.
   */
  const meter = options.meter;
  const fullPrice: RoutePrice =
    meter === undefined
      ? BASE_TINYBARS + INDEXED_DATA_TINYBARS
      : async (context) =>
          (await meter.quote(
            parseTransaction((await context.adapter.getBody?.()) as VerdictRequestBody),
          )).tinybars;

  /**
   * What an unpaid caller sees in the body of the 402.
   *
   * The default is an empty object, which tells a human nothing: the payment
   * requirements live in the `payment-required` header, so anyone poking the
   * endpoint with curl sees `{}` and reasonably concludes it is broken. A
   * service that refuses should say why and how to proceed — the header stays
   * the machine-readable contract, and this is the same information in a form
   * a person can read.
   */
  const explainPayment = (route: string, price: RoutePrice, rules: readonly string[]) =>
    async (context: PricingContext) => {
      const tinybars = typeof price === "bigint" ? price : await price(context);
      return {
        contentType: "application/json",
        body: {
          error: "payment_required",
          message: `This endpoint is paid per call. Send an x402 payment of ${formatHbar(tinybars)} HBAR to continue.`,
          price: { hbar: formatHbar(tinybars), tinybars: tinybars.toString(), asset: "HBAR" },
          rules,
          network: options.network,
          pay_to: options.payTo,
          how: [
            "Machine-readable requirements are in the `payment-required` response header (base64 JSON).",
            "An x402 client signs a Hedera transfer and retries with `payment-signature`.",
            "See GET /quote for prices without attempting payment.",
          ],
          route,
        },
      };
    };

  const paidRoutes: Record<string, unknown> = {
    "POST /verdict/local": {
      accepts: accepts(BASE_TINYBARS),
      description:
        "Pre-signature risk verdict: unlimited-approval and proxy-mutability checks over a simulated state diff.",
      mimeType: "application/json",
      unpaidResponseBody: explainPayment("/verdict/local", BASE_TINYBARS, ["R1", "R2"]),
    },
  };
  if (fullAvailable) {
    paidRoutes["POST /verdict/full"] = {
      accepts: accepts(fullPrice),
      description:
        "Pre-signature risk verdict including protocol invariant checks against freshness-gated indexed data, and the unidentified-counterparty class.",
      mimeType: "application/json",
      unpaidResponseBody: explainPayment(
        "/verdict/full",
        fullPrice,
        ["R1", "R2", "R3", "R4"],
      ),
    };
  }

  /*
   * Cast because @x402/hono declares `hono` as a peer and its emitted
   * MiddlewareHandler is generic over a Context that does not unify with the
   * one from the hoisted hono copy. Types only — the handler shape is
   * identical at runtime, and the cast is confined to the middleware value so
   * the route configuration above still type-checks. An earlier version cast
   * the routes too, which hid a wrong shape until it threw at startup.
   */
  /*
   * Requests are validated before the payment middleware sees them.
   *
   * The handler used to parse the transaction only after payment had been
   * verified, so a malformed body or an unsupported chain cost the caller a
   * 402 round trip and a signed payment before it was refused. Nothing was
   * settled — the middleware cancels settlement on any status of 400 or above
   * — but an agent should not have to sign a payment to learn that its request
   * could never be served. Hono caches the parsed body, so the handler's own
   * parse reads the same object rather than the stream twice.
   */
  /*
   * A size limit before anything reads the body. The validation below parses
   * it before payment is asked for, so without a limit one request carrying
   * hundreds of megabytes of "calldata" would cost memory nobody paid for.
   */
  app.use(
    "/verdict/*",
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      // The body is refused before it has been read, so the connection still
      // has unread bytes in it. Closing it keeps a reverse proxy from reusing
      // it for the next request, which otherwise arrived as a 502.
      onError: (c) => {
        c.header("Connection", "close");
        return c.json(
          {
            error: "payload_too_large",
            message: `request bodies are limited to ${MAX_BODY_BYTES} bytes (calldata up to ${MAX_CALLDATA_BYTES} bytes)`,
          },
          413,
        );
      },
    }),
  );

  app.use("/verdict/*", async (c, next) => {
    if (c.req.method !== "POST") return next();
    try {
      const transaction = parseTransaction((await c.req.json()) as VerdictRequestBody);
      parseJournalMode(c.req.query("journal"));
      if (!options.chainIds.includes(transaction.chainId)) {
        return c.json(
          {
            error: "unsupported_chain",
            message:
              `this instance simulates chain ${options.chainIds.join(", ")} only. A ` +
              `transaction for chain ${transaction.chainId} would be executed against ` +
              "the wrong chain's state, so it is refused rather than evaluated. " +
              "No payment was taken.",
            supported_chain_ids: options.chainIds,
          },
          400,
        );
      }
      // Pricing an unpaid full verdict counts deployments — the same work as
      // /quote?to= — so it draws on the same allowance.
      if (c.req.path === "/verdict/full") {
        admitCount(transaction, clientOf(c.req.header("x-forwarded-for")));
      }
    } catch (error) {
      if (error instanceof RateLimitedError) return tooMany(c, error);
      return c.json({ error: (error as Error).message }, 400);
    }
    return next();
  });

  /*
   * One payment signature, one verdict.
   *
   * The payment middleware verifies before the handler and settles after it,
   * so the handler's work — the simulation, gateway queries, a journal entry
   * the operator pays for — happens before anyone knows the payment settles.
   * The same `payment-signature` sent in ten concurrent requests verifies ten
   * times and settles once: nine verdicts for nothing. So a signature already
   * in flight is refused, and so is one that has already bought a verdict. A
   * signature whose request failed is forgotten, so a client may retry it.
   * The memory is this process's; a second instance behind the same proxy
   * would need a shared one.
   */
  const paymentsInFlight = new Set<string>();
  const paymentsUsed = new LruMap<string, number>(10_000);
  const PAYMENT_MEMORY_MS = 15 * 60 * 1000;
  app.use("/verdict/*", async (c, next) => {
    const signature = c.req.header("payment-signature") ?? c.req.header("x-payment");
    if (c.req.method !== "POST" || signature === undefined) return next();
    const key = createHash("sha256").update(signature).digest("hex");
    const usedAt = paymentsUsed.get(key);
    if (paymentsInFlight.has(key) || (usedAt !== undefined && Date.now() - usedAt < PAYMENT_MEMORY_MS)) {
      return c.json(
        {
          error: "payment_already_used",
          message:
            "This payment signature is already buying a verdict, or has bought one. " +
            "Sign a new payment for a new verdict.",
        },
        409,
      );
    }
    paymentsInFlight.add(key);
    try {
      await next();
      if (c.res.status < 400) paymentsUsed.set(key, Date.now());
    } finally {
      paymentsInFlight.delete(key);
    }
    return undefined;
  });

  app.use(paymentMiddleware(paidRoutes as never, server) as never);

  const handle =
    (
      pipeline: PresignPipeline,
      rules: readonly RuleId[],
      price?: (transaction: UnsignedTransaction) => Promise<Quote>,
    ) =>
    async (c: Context) => {
      let transaction: UnsignedTransaction;
      let journalMode: JournalMode;
      try {
        transaction = parseTransaction((await c.req.json()) as VerdictRequestBody);
        journalMode = parseJournalMode(c.req.query("journal"));
      } catch (error) {
        return c.json({ error: (error as Error).message }, 400);
      }

      const started = Date.now();
      // The same quote the 402 carried: the meter holds it well past the
      // exchange, so what the response says was charged is what was paid.
      const charged = price === undefined ? quote(rules) : await price(transaction);
      // Marked before the run so the payments attributed to this verdict are
      // the ones it actually caused, not everything the process has spent.
      const spentBefore = options.ledger?.count ?? 0;

      let outcome: Awaited<ReturnType<PresignPipeline["run"]>>;
      try {
        outcome = await pipeline.run(transaction);
      } catch (error) {
        /*
         * Payment is verified before this handler runs and settled after it,
         * so a thrown error would otherwise take the caller's money and return
         * nothing. Overriding the settlement to zero is the only honest
         * response: we could not produce the verdict, so we do not charge for
         * it.
         *
         * The 503 says the same thing in the status code — the request was
         * well-formed and we failed, so retrying later is reasonable, unlike a
         * 400 which would blame the caller.
         */
        try {
          setSettlementOverrides(c, { amount: "0" });
        } catch {
          // No payment context — the middleware let the request through
          // unpaid, so there is nothing to refund. Never let the refund
          // attempt turn an honest 503 into a 500: the caller needs the
          // reason far more than we need the override to succeed.
        }
        return c.json(
          {
            error: "verdict_unavailable",
            message:
              "the verdict could not be produced, so no payment was taken for it",
            detail: error instanceof Error ? error.message : String(error),
          },
          503,
        );
      }

      /*
       * Journalled before responding, unless the caller asked otherwise.
       *
       * A verdict the caller acts on but we never recorded is exactly the one
       * that will be disputed later, which is why waiting is the default. It
       * is not free: the entry is a Hedera consensus submit, a second or two,
       * on top of the settlement the payment already needs — two chain round
       * trips in a row for one answer, neither waiting on the other.
       *
       * `?journal=async` starts the write and answers without it. The record
       * is still made; what changes is that the response cannot cite it, so it
       * says `queued` rather than a sequence number it does not have.
       */
      /*
       * The salt is chosen here, before either write, so an asynchronous
       * response can hand it over even though the entry has not landed. It is
       * the only way the caller will ever match the public entry to their
       * transaction, and it is never published.
       */
      const salt = newSalt();
      let journalled: Record<string, unknown>;
      if (journalMode === "async") {
        const write = (async () => {
          try {
            await options.journal.record(transaction, outcome.verdict, salt);
          } catch (error: unknown) {
            journalFailures += 1;
            console.error(
              `  journal write failed after responding: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        })();
        pendingWrites.add(write);
        void write.finally(() => pendingWrites.delete(write));
        journalled = {
          mode: "async",
          topic: options.journal.topicId,
          status: "queued",
          tx_commitment: commitTransaction(transaction, salt),
          salt,
          note:
            "the entry is being written and this response cannot cite it. " +
            "Use ?journal=sync for a sequence number in the response.",
        };
      } else {
        const receipt = await options.journal.record(transaction, outcome.verdict, salt);
        journalled = {
          mode: "sync",
          topic: receipt.topicId,
          sequence: receipt.sequenceNumber,
          consensus_timestamp: receipt.consensusTimestamp,
          tx_commitment: receipt.entry.txCommitment,
          salt: receipt.salt,
        };
      }

      return c.json({
        decision: outcome.decision,
        verdict: {
          tier: outcome.verdict.tier,
          action: outcome.verdict.action,
          findings: outcome.verdict.findings.map((finding) => ({
            rule: finding.ruleId,
            severity: finding.severity,
            title: finding.title,
            detail: finding.detail,
            evidence: finding.evidence,
          })),
          provenance: outcome.verdict.provenance,
          effects: outcome.verdict.effects,
        },
        // What the call actually consumed, so the price is checkable rather
        // than merely quoted.
        cost: {
          rules_run: rules,
          indexed_sources_used: outcome.verdict.provenance.sources.length,
          elapsed_ms: Date.now() - started,
          charged: `${charged.hbar} HBAR`,
          pricing: charged.breakdown,
          /*
           * Both sides of the trade, in one place.
           *
           * `charged` is what the caller paid us; this is what producing their
           * verdict cost us upstream, per query, with the settlement hashes to
           * check it against. It is the difference between asserting a margin
           * and showing one — and the reason the claim "the cost of a verdict
           * is an observable number" is only true on the paid funding path.
           */
          paid_upstream: describeUpstream(options.ledger, spentBefore),
        },
        journal: journalled,
      });
    };

  app.post("/verdict/local", handle(options.pipelines.local, ["R1", "R2"]));
  if (options.pipelines.full !== undefined) {
    app.post(
      "/verdict/full",
      handle(
        options.pipelines.full,
        ["R1", "R2", "R3", "R4"],
        meter === undefined ? undefined : (transaction) => meter.quote(transaction),
      ),
    );
  }

  /*
   * A bare 404 is the wrong answer to `curl https://presign.dev/verdict`, which
   * is the first thing anyone tries: the verdict routes are split by what they
   * cost and what they read, and a caller who guessed the unsplit name has
   * asked a reasonable question. Name the routes rather than making them go
   * and find /llms.txt.
   */
  app.notFound((c) =>
    c.json(
      {
        error: "unknown_route",
        message: "No route at this path. The verdict routes are split by what they read.",
        routes: {
          "POST /verdict/local": "simulation, R1 and R2 — paid, flat",
          ...(options.pipelines.full === undefined
            ? {}
            : {
                "POST /verdict/full":
                  "the above plus R3 and R4 — paid, metered by the deployments R3 reads",
              }),
          "GET /quote": "prices a verdict without attempting payment — free",
          "GET /health": "rules, journal topic and the age of every list — free",
          ...(demo === undefined
            ? {}
            : {
                "GET /demo/examples": "the fixed transactions this instance judges — free",
                "GET /demo/verdict": "judge one of them at a chosen freshness budget — free",
              }),
        },
        integration: "/llms.txt",
      },
      404,
    ),
  );

  const api = app as PresignApp;
  api.drainJournal = async (timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs;
    while (pendingWrites.size > 0 && Date.now() < deadline) {
      await Promise.race([
        Promise.allSettled([...pendingWrites]),
        new Promise((resolve) => setTimeout(resolve, 250)),
      ]);
    }
  };
  return api;
}
