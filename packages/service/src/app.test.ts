import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createApp,
  createMeter,
  DEMO_BUDGETS,
  DEMO_EXAMPLES,
  FACILITATORS,
  parseJournalMode,
  publicRequest,
} from "../dist/index.js";
import type { Meter } from "../dist/index.js";
import type { PresignPipeline } from "@presign/gateway";
import { InMemoryVerdictJournal } from "@presign/hedera";

const journal = new InMemoryVerdictJournal();

const pipeline = (tier: string) =>
  ({
    run: () =>
      Promise.resolve({
        decision: "may_sign",
        verdict: {
          tier,
          action: "",
          findings: [],
          provenance: {
            simulatedAtBlock: 1,
            chainId: 1,
            sources: [],
            unavailableRules: [],
          },
          evaluatedAt: "2026-09-07T00:00:00Z",
        },
      }),
  }) as unknown as PresignPipeline;

const body = JSON.stringify({
  transaction: {
    from: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    to: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    value: "0",
    data: "0x",
    chainId: 1,
  },
});

const appWith = (full?: PresignPipeline, meter?: Meter) =>
  createApp({
    pipelines: full === undefined ? { local: pipeline("low") } : { local: pipeline("low"), full },
    ...(meter === undefined ? {} : { meter }),
    journal,
    payTo: "0.0.10398276",
    network: "hedera:testnet",
    chainIds: [1],
    // Never reached in these assertions; kept off the public facilitators so a
    // failing test cannot depend on someone else's uptime.
    facilitatorUrl: "http://127.0.0.1:9",
  });

test("behind a TLS proxy, a request carries the scheme callers actually used", async () => {
  const proxied = new Request("http://presign.dev/verdict/local", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-proto": "https" },
    body,
  });

  const rewritten = publicRequest(proxied);

  // The x402 middleware copies this URL into the payment manifest, which used
  // to advertise an http endpoint for a service whose own broker refuses one.
  assert.equal(rewritten.url, "https://presign.dev/verdict/local");
  assert.equal(rewritten.method, "POST");
  assert.deepEqual(await rewritten.json(), JSON.parse(body));

  // Nothing to upgrade: the request is passed through untouched.
  const direct = new Request("http://127.0.0.1:4021/health");
  assert.equal(publicRequest(direct), direct);
});

test("the landing page's examples are cached, and a stale answer says its age", async () => {
  let calls = 0;
  let failing = false;
  let clock = 1_700_000_000_000;
  const verdict = {
    tier: "low",
    action: "",
    findings: [],
    provenance: { simulatedAtBlock: 1, chainId: 1, sources: [], lists: [], unavailableRules: [] },
    effects: { observed: true, ethOutWei: "0", ethRecipients: [], tokensOut: [] },
    evaluatedAt: "2026-09-12T00:00:00Z",
  };
  const app = createApp({
    pipelines: { local: pipeline("low") },
    journal,
    payTo: "0.0.10398276",
    network: "hedera:testnet",
    chainIds: [1],
    facilitatorUrl: "http://127.0.0.1:9",
    demo: {
      examples: DEMO_EXAMPLES,
      budgets: DEMO_BUDGETS,
      ttlSeconds: 45,
      now: () => clock,
      evaluate: () => {
        calls += 1;
        return failing
          ? Promise.reject(new Error("the fork is gone"))
          : Promise.resolve(verdict as never);
      },
    },
  });
  const ask = async (query: string) => {
    const response = await app.request(`/demo/verdict?${query}`);
    return { status: response.status, body: (await response.json()) as Record<string, never> };
  };

  const first = await ask("example=aave-pool&budget=30");
  assert.equal(first.status, 200);
  assert.equal((first.body["verdict"] as { tier: string }).tier, "low");

  // A thousand readers inside the window cost the gateway what one does.
  clock += 10_000;
  const second = await ask("example=aave-pool&budget=30");
  assert.equal(calls, 1);
  assert.equal((second.body["computed"] as { age_seconds: number }).age_seconds, 10);

  /*
   * Past the window it is recomputed, and when that fails the last real answer
   * is served with its age instead of an error — the rule this service sells,
   * applied to its own output.
   */
  clock += 60_000;
  failing = true;
  const stale = await ask("example=aave-pool&budget=30");
  assert.equal(stale.status, 200);
  assert.equal(calls, 2);
  const computed = stale.body["computed"] as { age_seconds: number; could_not_refresh?: string };
  assert.equal(computed.age_seconds, 70);
  assert.match(String(computed.could_not_refresh), /the fork is gone/);

  // Fixed by construction: an example nobody defined, a budget nobody built.
  assert.equal((await ask("example=aave-pool&budget=7")).status, 400);
  assert.equal((await ask("example=nope&budget=30")).status, 404);

  // Nothing cached and nothing computable is an error, never an invented verdict.
  assert.equal((await ask("example=usdc-transfer&budget=30")).status, 503);
});

test("health reports whether a verdict could be produced, not that the process started", async () => {
  const app = createApp({
    pipelines: { local: pipeline("low") },
    journal,
    payTo: "0.0.10398276",
    network: "hedera:testnet",
    chainIds: [1],
    facilitatorUrl: "http://127.0.0.1:9",
    ready: () => Promise.resolve({ ok: false, detail: "the simulation fork is not answering" }),
  });

  const response = await app.request("/health");
  const body = (await response.json()) as { ok: boolean; not_ready?: string };

  // A healthcheck green while anvil is dead is worse than none at all: the
  // container looks fine and every verdict is a 503.
  assert.equal(response.status, 503);
  assert.equal(body.ok, false);
  assert.match(String(body.not_ready), /fork/);
});

test("a chain id this instance does not serve is refused on /quote, not priced", async () => {
  const app = appWith(pipeline("low"), createMeter({ count: () => Promise.resolve(2) }));

  // "abc" used to become NaN and be priced as a chain with nothing indexed.
  for (const chain of ["abc", "137", "1.5"]) {
    const response = await app.request(
      `/quote?to=0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48&chain_id=${chain}`,
    );
    assert.equal(response.status, 400, chain);
  }
  const served = await app.request("/quote?to=0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48&chain_id=1");
  assert.equal(served.status, 200);
});

test("with metering, the top-level price is the metered range, not a flat figure", async () => {
  const app = appWith(pipeline("low"), createMeter({ count: () => Promise.resolve(2) }));

  const quote = (await (await app.request("/quote")).json()) as {
    pricing?: string;
    hbar: string;
    tinybars: unknown;
  };

  assert.equal(quote.pricing, "metered");
  assert.equal(quote.hbar, "0.001–0.009");
  assert.equal(quote.tinybars, null);

  // The cheap rules alone are not metered, and keep their one price.
  const local = (await (await app.request("/quote?rules=R1,R2")).json()) as { hbar: string };
  assert.equal(local.hbar, "0.001");
});

test("one payment signature buys one verdict: a concurrent duplicate is refused", async () => {
  const app = appWith();
  const send = () =>
    app.request("/verdict/local", {
      method: "POST",
      body,
      headers: { "payment-signature": "the-same-signature" },
    });

  const statuses = (await Promise.all([send(), send()])).map((response) => response.status);

  // Verified twice and settled once would be two verdicts for one payment.
  assert.equal(statuses.filter((status) => status === 409).length, 1);
});

test("without an R3-capable pipeline, the dearer route does not exist", async () => {
  const app = appWith();

  const response = await app.request("/verdict/full", { method: "POST", body });

  /*
   * The regression this exists for: the route was always registered while the
   * process ran R1 and R2 alone, so a caller paying five times the price got
   * the cheaper verdict. Not 402, not 500 — the route must be absent, because
   * an absent route cannot be paid for.
   */
  assert.equal(response.status, 404);
});

test("the quote advertises only what this process can serve", async () => {
  const app = appWith();

  const quote = (await (await app.request("/quote")).json()) as {
    routes: Record<string, unknown>;
    note?: string;
  };

  assert.ok("/verdict/local" in quote.routes);
  // Quoting a price for work that cannot be done is the same lie told earlier.
  assert.ok(!("/verdict/full" in quote.routes));
  assert.match(String(quote.note), /R3 and R4 cannot run/);
  // The note has to say what the cheap route does *not* know, not only which
  // route is missing: a caller told "R4 is unavailable" learns nothing unless
  // they are also told that leaves the counterparty unidentified.
  assert.match(String(quote.note), /counterparty/i);
});

test("with an R3-capable pipeline, the dearer route is offered and priced", async () => {
  const app = appWith(pipeline("low"));

  const quote = (await (await app.request("/quote")).json()) as {
    routes: Record<string, { hbar: string }>;
  };

  assert.equal(quote.routes["/verdict/local"]?.hbar, "0.001");
  assert.equal(quote.routes["/verdict/full"]?.hbar, "0.005");
});

test("health states which rules this instance actually runs", async () => {
  const bare = (await (await appWith().request("/health")).json()) as { rules: string[] };
  const capable = (await (
    await appWith(pipeline("low")).request("/health")
  ).json()) as { rules: string[] };

  assert.deepEqual(bare.rules, ["R1", "R2"]);
  assert.deepEqual(capable.rules, ["R1", "R2", "R3", "R4"]);
});

/*
 * The 503-and-no-charge path is deliberately not unit-tested here.
 *
 * Payment is verified by the middleware before the handler runs, so an unpaid
 * request never reaches it — it stops at 402, or at a middleware error when
 * the facilitator is unreachable, as in these tests. Reaching the handler
 * requires a real settled payment, which makes this an integration concern
 * rather than a unit one.
 *
 * A test that asserted 503 by calling the app without payment would be
 * asserting against a path the middleware short-circuits, and would pass or
 * fail for reasons unrelated to the behaviour it claims to cover. Verified
 * against the running service instead.
 */

test("the journal mode defaults to sync and refuses anything else", () => {
  /*
   * Two chain round trips sit in the path of a paid verdict — the payment and
   * the journal entry — and neither waits on the other. A caller may skip the
   * second; the default does not, because that is what this service already
   * promised and quietly turning an assurance into an intention is not an
   * upgrade.
   */
  assert.equal(parseJournalMode(undefined), "sync");
  assert.equal(parseJournalMode(""), "sync");
  assert.equal(parseJournalMode("sync"), "sync");
  assert.equal(parseJournalMode("async"), "async");

  // Falling back silently would charge a caller who asked for speed the two
  // seconds they were trying to avoid, and never tell them why.
  assert.throws(() => parseJournalMode("maybe"), /sync.*async/);
  assert.throws(() => parseJournalMode("SYNC"), /sync.*async/);
});

test("/health names the journal topic and counts writes lost after responding", async () => {
  const health = (await (await appWith(pipeline("low")).request("/health")).json()) as {
    journal: { topic: string; failed_async_writes: number };
  };

  // An asynchronous write has nobody left to tell — the caller is gone — so
  // this count is the only place the loss becomes visible.
  assert.equal(health.journal.failed_async_writes, 0);
  assert.ok(typeof health.journal.topic === "string");
});

const withChain = (chainId: number) =>
  JSON.stringify({
    transaction: { ...(JSON.parse(body) as { transaction: object }).transaction, chainId },
  });

test("a transaction for another chain is refused before any payment is asked for", async () => {
  const response = await appWith(pipeline("low")).request("/verdict/local", {
    method: "POST",
    body: withChain(8453),
  });

  /*
   * 400, not 402. This instance forks Ethereum, and USDC on Base used to be
   * paid for, simulated against mainnet state and returned `low`. Refusing
   * after payment would cancel the settlement, but the caller would still have
   * signed a payment for a request that could never be served.
   */
  assert.equal(response.status, 400);
  const payload = (await response.json()) as {
    error: string;
    supported_chain_ids: number[];
  };
  assert.equal(payload.error, "unsupported_chain");
  assert.deepEqual(payload.supported_chain_ids, [1]);
});

test("a malformed transaction is refused before payment too", async () => {
  const response = await appWith().request("/verdict/local", {
    method: "POST",
    body: JSON.stringify({ transaction: { from: "0x1", data: "0x" } }),
  });

  assert.equal(response.status, 400);
  assert.match(((await response.json()) as { error: string }).error, /chainId/);
});

test("quote and health name the chains served and the facilitator that settles", async () => {
  const app = appWith(pipeline("low"));
  const quote = (await (await app.request("/quote")).json()) as {
    chain_ids: number[];
    facilitator: string;
  };
  const health = (await (await app.request("/health")).json()) as {
    chain_ids: number[];
    facilitator: string;
  };

  assert.deepEqual(quote.chain_ids, [1]);
  assert.deepEqual(health.chain_ids, [1]);
  assert.equal(quote.facilitator, "http://127.0.0.1:9");
  assert.equal(health.facilitator, "http://127.0.0.1:9");
});

test("a metered instance quotes the full verdict by the deployments it will read", async () => {
  const POOL = "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640";
  const meter = createMeter({
    count: (transaction) => Promise.resolve(transaction.to?.toLowerCase() === POOL ? 3 : 0),
  });
  const app = appWith(pipeline("low"), meter);

  const general = (await (await app.request("/quote")).json()) as {
    routes: Record<string, { pricing?: string; hbar: string; per_deployment_hbar?: string }>;
  };
  assert.equal(general.routes["/verdict/full"]?.pricing, "metered");
  assert.equal(general.routes["/verdict/full"]?.hbar, "0.001–0.009");
  assert.equal(general.routes["/verdict/full"]?.per_deployment_hbar, "0.001");

  const pool = (await (await app.request(`/quote?to=${POOL}`)).json()) as {
    quote_for: { hbar: string; deployments: number; breakdown: { item: string }[] };
  };
  // Three deployments read, three units charged; USDC, read from none, pays the base.
  assert.equal(pool.quote_for.hbar, "0.004");
  assert.equal(pool.quote_for.deployments, 3);

  const usdc = (await (
    await app.request("/quote?to=0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48")
  ).json()) as { quote_for: { hbar: string } };
  assert.equal(usdc.quote_for.hbar, "0.001");

  const bad = await app.request("/quote?to=not-an-address");
  assert.equal(bad.status, 400);
});

test("an oversized body is refused before it is read", async () => {
  const tx = (JSON.parse(body) as { transaction: object }).transaction;
  const response = await appWith().request("/verdict/local", {
    method: "POST",
    body: JSON.stringify({ transaction: { ...tx, data: `0x${"ab".repeat(400_000)}` } }),
  });

  // Parsed before payment is asked for, so an unlimited body is free memory
  // for whoever sends it.
  assert.equal(response.status, 413);
});

test("a malformed address, calldata or value is refused before payment", async () => {
  const tx = (JSON.parse(body) as { transaction: object }).transaction;
  const cases: readonly [string, string, RegExp][] = [
    ["from", "0x1234", /transaction\.from/],
    ["to", "not-an-address", /transaction\.to/],
    ["data", "0xzz", /transaction\.data/],
    ["value", "-1", /transaction\.value/],
  ];
  for (const [field, value, pattern] of cases) {
    const response = await appWith().request("/verdict/local", {
      method: "POST",
      body: JSON.stringify({ transaction: { ...tx, [field]: value } }),
    });
    assert.equal(response.status, 400, field);
    assert.match(((await response.json()) as { error: string }).error, pattern);
  }
});

test("pricing new counterparties is limited per client, and held prices are not", async () => {
  const app = createApp({
    pipelines: { local: pipeline("low"), full: pipeline("low") },
    journal,
    payTo: "0.0.10398276",
    network: "hedera:testnet",
    chainIds: [1],
    facilitatorUrl: "http://127.0.0.1:9",
    meter: createMeter({ count: () => Promise.resolve(1) }),
    meterRequestsPerMinute: 2,
  });
  const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
  const ask = (to: string, ip = "203.0.113.7") =>
    app.request(`/quote?to=${to}`, { headers: { "x-forwarded-for": `${ip}, 10.0.0.1` } });

  assert.equal((await ask(address(1))).status, 200);
  assert.equal((await ask(address(2))).status, 200);

  // Walking through addresses makes the service count deployments for each,
  // for free. The third new one in a minute is refused.
  const limited = await ask(address(3));
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) >= 1);

  // A price already held costs nothing to repeat, and another client has its
  // own allowance.
  assert.equal((await ask(address(1))).status, 200);
  assert.equal((await ask(address(3), "198.51.100.9")).status, 200);
});

test("both Hedera networks settle through Blocky402", () => {
  // Testnet has its own host, which the main host's /supported never mentions.
  assert.equal(FACILITATORS["hedera:testnet"], "https://api.testnet.blocky402.com");
  assert.equal(FACILITATORS["hedera:mainnet"], "https://api.blocky402.com");
});
