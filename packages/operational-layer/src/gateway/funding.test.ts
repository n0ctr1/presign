import assert from "node:assert/strict";
import { test } from "node:test";

import { privateKeyToAccount } from "viem/accounts";

import {
  chooseFunding,
  formatUnits6,
  GatewayClient,
  PaymentLedger,
  StudioKeyFunding,
  X402Funding,
} from "../../dist/index.js";

const NOW = new Date("2026-09-08T01:00:00Z");
const DEPLOYMENT = "QmZunURmiSdnk87m9ejS2GkP6cqBbqiPtDZSTGgQwjiNmu";
const OTHER = "QmcXE5QVcBcvAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const BASE_URL = "https://gateway.thegraph.com/api";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/** A throwaway key: this signs typed data offline and never holds value. */
const account = privateKeyToAccount(`0x${"11".repeat(32)}`);

test("formats six-decimal amounts without floating point", () => {
  assert.equal(formatUnits6("10000", "USDC"), "0.01 USDC");
  assert.equal(formatUnits6("1000000", "USDC"), "1 USDC");
  assert.equal(formatUnits6("1500000", "USDC"), "1.5 USDC");
  assert.equal(formatUnits6("0", "USDC"), "0 USDC");
});

test("the x402 endpoint is pinned to a deployment, never to a subgraph", () => {
  const funding = new X402Funding({ signer: account, ledger: new PaymentLedger() });

  const url = funding.url(BASE_URL, DEPLOYMENT);

  /*
   * The registry advertises only `/x402/subgraphs/id/<subgraphId>`. Taking it
   * would cost the pinning the rest of this package depends on: a subgraph id
   * floats to whatever version its owner publishes next, so provenance quoting
   * one names something that may already have changed underneath it.
   */
  assert.equal(url, `${BASE_URL}/x402/deployments/id/${DEPLOYMENT}`);
  assert.ok(!url.includes("/subgraphs/"));
});

test("a studio key travels as a bearer header on the keyed endpoint", async () => {
  const funding = new StudioKeyFunding(() => Promise.resolve("k-123"));

  assert.equal(funding.url(BASE_URL, DEPLOYMENT), `${BASE_URL}/deployments/id/${DEPLOYMENT}`);
  assert.deepEqual(await funding.headers(), { Authorization: "Bearer k-123" });
});

test("a client with neither a key nor a funding method fails at construction", () => {
  // Failing here beats failing at the first query, where it would look like a
  // gateway problem rather than a wiring one.
  assert.throws(() => new GatewayClient({} as never), /apiKey.*funding/);
});

test("the ledger totals per asset and never across them", () => {
  const ledger = new PaymentLedger();
  const payment = (amount: string, asset: string, network: string) => ({
    deploymentId: DEPLOYMENT,
    amount,
    display: formatUnits6(amount, "X"),
    asset,
    network,
    paidAt: NOW.toISOString(),
    transaction: null,
  });

  ledger.record(payment("10000", USDC, "eip155:8453"));
  const mark = ledger.count;
  ledger.record(payment("10000", USDC, "eip155:8453"));
  ledger.record(payment("500", "0.0.0", "hedera:testnet"));

  // Summing USDC and HBAR into one figure needs an exchange rate, and a rate
  // we invented would turn a measured number into an estimate in disguise.
  assert.deepEqual(ledger.totals(), {
    [`eip155:8453:${USDC}`]: "20000",
    "hedera:testnet:0.0.0": "500",
  });
  assert.equal(ledger.since(mark).length, 2);
});

/**
 * A gateway that charges, driven entirely offline.
 *
 * EIP-3009 is why this works without a network: the payment is a typed-data
 * signature the facilitator submits, so the client signs and never broadcasts.
 * Nothing here needs an RPC, a chain, or a funded wallet.
 */
function payingGateway(options: {
  amount: string;
  settles?: boolean;
  onRequest?: (url: string, init: RequestInit | undefined) => void;
}) {
  const manifest = (url: string) =>
    Buffer.from(
      JSON.stringify({
        x402Version: 2,
        error: "Payment-Signature header is required",
        resource: { url },
        accepts: [
          {
            scheme: "exact",
            network: "eip155:8453",
            amount: options.amount,
            payTo: "0x79DC34E41B2b591078d3dE222C43EcaaBD52FcCB",
            maxTimeoutSeconds: 300,
            asset: USDC,
            extra: { assetTransferMethod: "eip3009", name: "USD Coin", version: "2" },
          },
        ],
      }),
    ).toString("base64");

  const settlement = Buffer.from(
    JSON.stringify({
      success: options.settles ?? true,
      transaction: "0xsettled",
      network: "eip155:8453",
      ...(options.settles === false ? { errorReason: "insufficient_funds" } : {}),
    }),
  ).toString("base64");

  const calls: string[] = [];
  /*
   * Reads headers off a Request rather than off `init`, because that is what
   * the wrapper actually hands an inner fetch: it builds one Request and
   * re-sends clones of it with the signature attached. A stub inspecting
   * `init.headers` sees no payment on either attempt and makes working code
   * look broken.
   */
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = request.url;
    options.onRequest?.(url, init);
    const signed = request.headers.get("payment-signature");
    calls.push(signed === null ? "unpaid" : "paid");

    if (signed === null) {
      return new Response(null, {
        status: 402,
        headers: { "payment-required": manifest(url) },
      });
    }
    return new Response(JSON.stringify({ data: { _meta: { block: { number: 1 } } } }), {
      status: 200,
      headers: { "content-type": "application/json", "payment-response": settlement },
    });
  }) as unknown as typeof globalThis.fetch;

  return { fetch: fetchImpl, calls };
}

test("a query pays on 402, retries, and records what the manifest asked", async () => {
  const ledger = new PaymentLedger();
  const gateway = payingGateway({ amount: "10000" });
  const client = new GatewayClient({
    baseUrl: BASE_URL,
    timeoutMs: 30_000,
    funding: new X402Funding({
      signer: account,
      ledger,
      fetch: gateway.fetch,
      now: () => NOW,
    }),
  });

  const data = await client.query<{ _meta: unknown }>(DEPLOYMENT, "{ _meta { block { number } } }");

  assert.ok(data._meta);
  // Two round trips: the price is quoted, then paid. This is why the paid path
  // needs a wider timeout than the keyed one.
  assert.deepEqual(gateway.calls, ["unpaid", "paid"]);

  assert.equal(ledger.payments.length, 1);
  const [payment] = ledger.payments;
  // The amount is read from the gateway's own manifest, not from its docs.
  assert.equal(payment!.amount, "10000");
  assert.equal(payment!.display, "0.01 USDC");
  assert.equal(payment!.asset, USDC);
  assert.equal(payment!.deploymentId, DEPLOYMENT);
  assert.equal(payment!.transaction, "0xsettled");
});

test("a process stops paying at its total ceiling, before signing", async () => {
  const ledger = new PaymentLedger();
  const gateway = payingGateway({ amount: "10000" });
  const client = new GatewayClient({
    baseUrl: BASE_URL,
    timeoutMs: 30_000,
    funding: new X402Funding({ signer: account, ledger, fetch: gateway.fetch, maxTotalAmount: "15000" }),
  });

  await client.query(DEPLOYMENT, "{ _meta { block { number } } }");
  // The second cent would pass the per-query cap and break the total.
  await assert.rejects(
    client.query(DEPLOYMENT, "{ _meta { block { number } } }"),
    /spend limit of 0\.015 USDC/,
  );

  assert.equal(ledger.payments.length, 1);
  // Priced, then refused: no signature was sent for the second query.
  assert.deepEqual(gateway.calls, ["unpaid", "paid", "unpaid"]);
});

test("a query's timeout starts at its turn in the payment queue", async () => {
  const ledger = new PaymentLedger();
  const inner = payingGateway({ amount: "10000" });
  // Every round trip takes 40 ms and honours the abort signal, as a real
  // fetch does. A paid query is two round trips.
  const slow = (async (input: string | URL | Request, init?: RequestInit) => {
    await new Promise((resolve) => setTimeout(resolve, 40));
    const signal = input instanceof Request ? input.signal : init?.signal;
    if (signal?.aborted) throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    return inner.fetch(input as never, init as never);
  }) as unknown as typeof globalThis.fetch;
  const client = new GatewayClient({
    baseUrl: BASE_URL,
    timeoutMs: 150,
    funding: new X402Funding({ signer: account, ledger, fetch: slow }),
  });

  // Four queued queries finish around 320 ms. A timer started before the
  // queue expired for the last two while their payments were being made.
  await Promise.all(
    [DEPLOYMENT, OTHER, DEPLOYMENT, OTHER].map((id) => client.query(id, "{ _meta { block { number } } }")),
  );
  assert.equal(ledger.payments.length, 4);
});

test("a settlement that failed is not recorded as a cost", async () => {
  const ledger = new PaymentLedger();
  const gateway = payingGateway({ amount: "10000", settles: false });
  const client = new GatewayClient({
    baseUrl: BASE_URL,
    timeoutMs: 30_000,
    funding: new X402Funding({ signer: account, ledger, fetch: gateway.fetch }),
  });

  await client.query(DEPLOYMENT, "{ _meta { block { number } } }");

  // The gateway was not paid. Recording it would overstate what a verdict cost
  // by exactly the amount that never left the wallet.
  assert.equal(ledger.payments.length, 0);
});

test("concurrent queries attribute each price to its own deployment", async () => {
  const ledger = new PaymentLedger();
  // Different prices per deployment, so a shared manifest slot would show up
  // as one deployment's cost recorded against the other.
  const priceFor = (url: string) => (url.includes(OTHER) ? "25000" : "10000");
  const gateway = {
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const inner = payingGateway({ amount: priceFor(url) });
      return inner.fetch(input as never, init as never);
    }) as unknown as typeof globalThis.fetch,
  };
  const client = new GatewayClient({
    baseUrl: BASE_URL,
    timeoutMs: 30_000,
    funding: new X402Funding({ signer: account, ledger, fetch: gateway.fetch }),
  });

  await Promise.all([
    client.query(DEPLOYMENT, "{ _meta { block { number } } }"),
    client.query(OTHER, "{ _meta { block { number } } }"),
  ]);

  const byDeployment = Object.fromEntries(
    ledger.payments.map((p) => [p.deploymentId, p.amount]),
  );
  assert.deepEqual(byDeployment, { [DEPLOYMENT]: "10000", [OTHER]: "25000" });
});

const PAYER_KEY = `0x${"22".repeat(32)}`;

test("a Studio key is preferred when one exists, so nothing spends by accident", () => {
  const choice = chooseFunding({
    studioKey: "k-123",
    payerKey: PAYER_KEY,
    ledger: new PaymentLedger(),
  });

  assert.equal(choice.funding.kind, "studio-key");
  assert.match(choice.reason, /GATEWAY_FUNDING=x402/);
});

test("no Studio key and a funded wallet is the case x402 exists for", () => {
  const choice = chooseFunding({
    studioKey: null,
    payerKey: PAYER_KEY,
    ledger: new PaymentLedger(),
  });

  // The Graph's own documentation names this: "you have a funded wallet and no
  // API key, and no human to mint one". An agent at three in the morning
  // cannot open a browser and sign up.
  assert.equal(choice.funding.kind, "x402");
  assert.match(choice.reason, /no Studio key/);
});

test("x402 can be demanded explicitly even when a key would work", () => {
  const choice = chooseFunding({
    studioKey: "k-123",
    payerKey: PAYER_KEY,
    ledger: new PaymentLedger(),
    prefer: "x402",
  });

  assert.equal(choice.funding.kind, "x402");
  assert.match(choice.reason, /0x[0-9a-fA-F]{40}/);
});

test("demanding x402 without a payer key fails loudly rather than falling back", () => {
  // Falling back to the key here would answer a request to spend by quietly
  // not spending, and the operator would never learn the wallet was missing.
  assert.throws(
    () =>
      chooseFunding({ studioKey: "k-123", payerKey: null, ledger: new PaymentLedger(), prefer: "x402" }),
    /no payer key/,
  );
});

test("with neither a key nor a wallet, queries cannot be funded at all", () => {
  assert.throws(
    () => chooseFunding({ studioKey: null, payerKey: null, ledger: new PaymentLedger() }),
    /cannot be funded/,
  );
});

test("a refused payment is reported by its reason, not as a broken response", async () => {
  const refusal = Buffer.from(
    JSON.stringify({
      x402Version: 2,
      error: "Verification failed: invalid_exact_evm_insufficient_balance",
      resource: { url: "https://example.test" },
      accepts: [],
    }),
  ).toString("base64");

  // Always 402: the gateway quotes a price, takes the signature, and refuses.
  const alwaysRefuses = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const manifest = Buffer.from(
      JSON.stringify({
        x402Version: 2,
        error: "Payment-Signature header is required",
        resource: { url: request.url },
        accepts: [
          {
            scheme: "exact",
            network: "eip155:8453",
            amount: "10000",
            payTo: "0x79DC34E41B2b591078d3dE222C43EcaaBD52FcCB",
            maxTimeoutSeconds: 300,
            asset: USDC,
            extra: { assetTransferMethod: "eip3009", name: "USD Coin", version: "2" },
          },
        ],
      }),
    ).toString("base64");
    const paid = request.headers.get("payment-signature") !== null;
    return new Response(null, {
      status: 402,
      headers: { "payment-required": paid ? refusal : manifest },
    });
  }) as unknown as typeof globalThis.fetch;

  const ledger = new PaymentLedger();
  const client = new GatewayClient({
    baseUrl: BASE_URL,
    timeoutMs: 30_000,
    funding: new X402Funding({ signer: account, ledger, fetch: alwaysRefuses }),
  });

  await assert.rejects(
    () => client.query(DEPLOYMENT, "{ _meta { block { number } } }"),
    /payment was refused: .*insufficient_balance/,
  );
  // Nothing left the wallet, so nothing is a cost.
  assert.equal(ledger.payments.length, 0);
});

test("payments are sent one at a time, because the gateway refuses overlap", async () => {
  let inFlight = 0;
  let maxInFlight = 0;

  const gateway = payingGateway({ amount: "10000" });
  const counting = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const paid = request.headers.get("payment-signature") !== null;
    if (paid) {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
    }
    try {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return await gateway.fetch(request);
    } finally {
      if (paid) inFlight -= 1;
    }
  }) as unknown as typeof globalThis.fetch;

  const ledger = new PaymentLedger();
  const client = new GatewayClient({
    baseUrl: BASE_URL,
    timeoutMs: 30_000,
    funding: new X402Funding({ signer: account, ledger, fetch: counting }),
  });

  await Promise.all([
    client.query(DEPLOYMENT, "{ _meta { block { number } } }"),
    client.query(OTHER, "{ _meta { block { number } } }"),
    client.query(DEPLOYMENT, "{ _meta { block { number } } }"),
  ]);

  // Observed live: four paid requests in flight together returned two answers
  // and two bare 402s. R3 probes candidates in parallel, so without this the
  // paid path drops probes at random while the wallet is funded.
  assert.equal(maxInFlight, 1);
  assert.equal(ledger.payments.length, 3);
});

test("one failed payment does not poison the queue behind it", async () => {
  let attempt = 0;
  const gateway = payingGateway({ amount: "10000" });
  const failsOnce = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.headers.get("payment-signature") !== null) {
      attempt += 1;
      if (attempt === 1) throw new Error("transport blew up");
    }
    return gateway.fetch(request);
  }) as unknown as typeof globalThis.fetch;

  const ledger = new PaymentLedger();
  const client = new GatewayClient({
    baseUrl: BASE_URL,
    timeoutMs: 30_000,
    funding: new X402Funding({ signer: account, ledger, fetch: failsOnce }),
  });

  const results = await Promise.allSettled([
    client.query(DEPLOYMENT, "{ _meta { block { number } } }"),
    client.query(OTHER, "{ _meta { block { number } } }"),
  ]);

  assert.equal(results[0]!.status, "rejected");
  // The second query queued behind a payment that threw. If the queue chained
  // on rejection it would never run, and one transport blip would take out
  // every probe after it.
  assert.equal(results[1]!.status, "fulfilled");
});
