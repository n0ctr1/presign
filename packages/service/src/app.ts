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
 * metered gateway. Charging both the same would make cheap callers subsidise
 * expensive ones and would hide the only cost in the system that scales.
 *
 * The dearer route is registered **only** when a pipeline that can actually run
 * R3 is supplied. An earlier version always exposed it while the process was
 * wired with R1 and R2 alone, so a caller paying five times the price received
 * exactly the cheaper verdict. Taking money for work the process cannot perform
 * is the worst failure available to a service that sells honesty, and a comment
 * saying so did not prevent it — the types now do.
 */

import { Hono, type Context } from "hono";
import { paymentMiddleware, setSettlementOverrides } from "@x402/hono";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { ExactHederaScheme } from "@x402/hedera/exact/server";

import type { PresignPipeline } from "@presign/gateway";
import type { VerdictJournal } from "@presign/hedera";
import type { UnsignedTransaction } from "@presign/verdict-engine";

import { parseRules, quote, formatHbar, BASE_TINYBARS, INDEXED_DATA_TINYBARS, type RuleId } from "./pricing.js";

export type HederaNetwork = "hedera:testnet" | "hedera:mainnet";

/**
 * Facilitators split by network, which is not obvious and bites late.
 *
 * `x402.org` settles `hedera:testnet` only; Blocky402 settles `hedera:mainnet`
 * only. Pointing the wrong one at a network produces a startup sync failure
 * rather than a clear message, so the mapping is explicit here.
 */
export const FACILITATORS: Readonly<Record<HederaNetwork, string>> = {
  "hedera:testnet": "https://x402.org/facilitator",
  "hedera:mainnet": "https://api.blocky402.com",
};

export interface ServicePipelines {
  /** R1 and R2: simulation and local checks. Always required. */
  readonly local: PresignPipeline;
  /**
   * R1, R2 and R3. Omit when indexed data is unavailable — the `/verdict/full`
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
  readonly journal: VerdictJournal;
  /** Hedera account that receives payment. */
  readonly payTo: string;
  readonly network: HederaNetwork;
  /** Override the facilitator, e.g. a self-hosted one. */
  readonly facilitatorUrl?: string;
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

/** Reject a malformed transaction before charging for it. */
function parseTransaction(body: VerdictRequestBody): UnsignedTransaction {
  const raw = body.transaction;
  if (raw === undefined) throw new RangeError("body.transaction is required");
  if (typeof raw.from !== "string") throw new RangeError("transaction.from is required");
  if (typeof raw.data !== "string") throw new RangeError("transaction.data is required");
  if (typeof raw.chainId !== "number") throw new RangeError("transaction.chainId is required");

  return {
    from: raw.from as never,
    to: (raw.to ?? null) as never,
    value: BigInt(raw.value ?? "0"),
    data: raw.data as never,
    chainId: raw.chainId,
  };
}

export function createApp(options: ServiceOptions): Hono {
  const app = new Hono();

  const facilitator = new HTTPFacilitatorClient({
    url: options.facilitatorUrl ?? FACILITATORS[options.network],
  });
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
  app.get("/quote", (c) => {
    try {
      const rules = parseRules(c.req.query("rules"));
      const routes: Record<string, unknown> = {
        "/verdict/local": {
          rules: ["R1", "R2"],
          hbar: formatHbar(BASE_TINYBARS),
          buys: "simulation, approval and proxy-mutability checks",
        },
      };
      if (fullAvailable) {
        routes["/verdict/full"] = {
          rules: ["R1", "R2", "R3"],
          hbar: formatHbar(BASE_TINYBARS + INDEXED_DATA_TINYBARS),
          buys: "the above, plus protocol invariants from freshness-gated indexed data",
        };
      }
      return c.json({
        network: options.network,
        pay_to: options.payTo,
        asset: "HBAR",
        ...quote(rules),
        tinybars: quote(rules).tinybars.toString(),
        routes,
        ...(fullAvailable
          ? {}
          : {
              note: "This instance has no indexed-data source configured, so R3 cannot run and /verdict/full is not offered.",
            }),
      });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  app.get("/health", (c) =>
    c.json({
      ok: true,
      network: options.network,
      payTo: options.payTo,
      rules: fullAvailable ? ["R1", "R2", "R3"] : ["R1", "R2"],
      sources: (options.sources?.() ?? []).map((source) => ({
        name: source.name,
        live: source.live,
        ...(source.detail ?? {}),
      })),
    }),
  );

  /** One payment option per route: HBAR on the configured network. */
  const accepts = (tinybars: bigint) => ({
    scheme: "exact",
    payTo: options.payTo,
    // Quoted as an explicit asset amount rather than a dollar figure, so the
    // charge does not move with an exchange rate between quote and payment.
    // HBAR amounts are in tinybars.
    price: { asset: "0.0.0", amount: tinybars.toString() },
    network: options.network,
  });

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
  const explainPayment = (route: string, tinybars: bigint, rules: readonly string[]) =>
    () => ({
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
    });

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
      accepts: accepts(BASE_TINYBARS + INDEXED_DATA_TINYBARS),
      description:
        "Pre-signature risk verdict including protocol invariant checks against freshness-gated indexed data.",
      mimeType: "application/json",
      unpaidResponseBody: explainPayment(
        "/verdict/full",
        BASE_TINYBARS + INDEXED_DATA_TINYBARS,
        ["R1", "R2", "R3"],
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
  app.use(paymentMiddleware(paidRoutes as never, server) as never);

  const handle =
    (pipeline: PresignPipeline, rules: readonly RuleId[]) =>
    async (c: Context) => {
      let transaction: UnsignedTransaction;
      try {
        transaction = parseTransaction((await c.req.json()) as VerdictRequestBody);
      } catch (error) {
        return c.json({ error: (error as Error).message }, 400);
      }

      const started = Date.now();

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

      // Journalled before responding. A verdict the caller acts on but we
      // never recorded is exactly the one that will be disputed later.
      const receipt = await options.journal.record(transaction, outcome.verdict);

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
        },
        // What the call actually consumed, so the price is checkable rather
        // than merely quoted.
        cost: {
          rules_run: rules,
          indexed_sources_used: outcome.verdict.provenance.sources.length,
          elapsed_ms: Date.now() - started,
          charged: quote(rules).hbar + " HBAR",
        },
        journal: {
          topic: receipt.topicId,
          sequence: receipt.sequenceNumber,
          consensus_timestamp: receipt.consensusTimestamp,
          tx_hash: receipt.entry.txHash,
        },
      });
    };

  app.post("/verdict/local", handle(options.pipelines.local, ["R1", "R2"]));
  if (options.pipelines.full !== undefined) {
    app.post("/verdict/full", handle(options.pipelines.full, ["R1", "R2", "R3"]));
  }

  return app;
}
