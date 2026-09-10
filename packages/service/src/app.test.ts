import assert from "node:assert/strict";
import { test } from "node:test";

import { createApp, parseJournalMode } from "../dist/index.js";
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

const appWith = (full?: PresignPipeline) =>
  createApp({
    pipelines: full === undefined ? { local: pipeline("low") } : { local: pipeline("low"), full },
    journal,
    payTo: "0.0.10398276",
    network: "hedera:testnet",
    // Never reached in these assertions; kept off the public facilitators so a
    // failing test cannot depend on someone else's uptime.
    facilitatorUrl: "http://127.0.0.1:9",
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
