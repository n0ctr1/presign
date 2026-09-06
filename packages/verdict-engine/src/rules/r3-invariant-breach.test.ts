import assert from "node:assert/strict";
import { test } from "node:test";

import { InvariantBreachRule } from "../../dist/index.js";
import type { UnsignedTransaction } from "../../dist/index.js";

const POOL = "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2";
const AGENT = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const T0 = new Date("2026-09-06T12:00:00Z");

const tx = (overrides: Partial<UnsignedTransaction> = {}) =>
  ({ from: AGENT, to: POOL, value: 0n, data: "0x", chainId: 1, ...overrides }) as UnsignedTransaction;

const context = (transaction = tx()) =>
  ({
    transaction,
    diff: { pre: {}, post: {}, blockNumber: 1, revertReason: null },
    getStorageAt: () => Promise.reject(new Error("unused")),
    getCode: () => Promise.reject(new Error("unused")),
    call: () => Promise.resolve(null),
  }) as never;

/** A satisfied capability naming one deployment 4 seconds behind head. */
const satisfied = {
  satisfied: true,
  ruleId: "R3",
  records: [
    {
      candidate: { deploymentId: "QmAave", displayName: "Aave V3 Ethereum" },
      liveness: { lagSeconds: 4, checkedAt: T0, indexedBlock: 25916120 },
      conformance: { answersFields: [], missingFields: [] },
    },
  ],
};

function protocolReturning(options: {
  family?: string | null;
  resolution?: unknown;
  markets?: unknown[];
  queryThrows?: string;
}) {
  return {
    identifyFamily: () => Promise.resolve(options.family ?? "lending-cdp"),
    resolveCapability: () => Promise.resolve(options.resolution ?? satisfied),
    query: () =>
      options.queryThrows !== undefined
        ? Promise.reject(new Error(options.queryThrows))
        : Promise.resolve({ markets: options.markets ?? [] }),
  } as never;
}

const rule = (protocol: never) =>
  new InvariantBreachRule({ protocol, now: () => T0 });

const healthyMarket = {
  id: "0x4d5f47fa6a74757f35c14fd3a6ef8e3c9bc514e8",
  name: "Aave Ethereum WETH",
  totalValueLockedUSD: "5381128522.62",
  totalDepositBalanceUSD: "5381128522.62",
  totalBorrowBalanceUSD: "4437373949.91",
  inputTokenBalance: "2150241868832575325029252",
};

test("stale context yields unavailable, never a clean result", async () => {
  const outcome = await rule(
    protocolReturning({
      resolution: {
        satisfied: false,
        ruleId: "R3",
        reason: "all_candidates_stale",
        rejected: [{}, {}],
      },
    }),
  ).evaluate(context());

  // The whole point of the layer. An empty finding list here would mean
  // "checked, looks fine" — on data nobody could obtain.
  assert.equal(outcome.status, "unavailable");
  assert.ok(outcome.status === "unavailable");
  assert.equal(outcome.reason, "all_candidates_stale");
  assert.match(outcome.detail, /2 candidate\(s\) rejected/);
});

test("a failed query is unavailable, not a healthy protocol", async () => {
  const outcome = await rule(
    protocolReturning({ queryThrows: "gateway timeout" }),
  ).evaluate(context());

  assert.equal(outcome.status, "unavailable");
  assert.ok(outcome.status === "unavailable");
  assert.equal(outcome.reason, "query_failed");
});

test("an unconfigured chain is unavailable rather than silently skipped", async () => {
  const outcome = await rule(protocolReturning({})).evaluate(
    context(tx({ chainId: 999_999 })),
  );

  assert.equal(outcome.status, "unavailable");
  assert.ok(outcome.status === "unavailable");
  assert.equal(outcome.reason, "unsupported_network");
});

test("an unidentified counterparty is not R3's to report", async () => {
  const outcome = await rule(protocolReturning({ family: null })).evaluate(context());

  // The "unknown contract" class belongs to the engine. Reporting it here too
  // would double-count one fact.
  assert.equal(outcome.status, "evaluated");
  assert.ok(outcome.status === "evaluated");
  assert.deepEqual(outcome.findings, []);
});

test("a healthy protocol produces no findings", async () => {
  const outcome = await rule(
    protocolReturning({ markets: [healthyMarket] }),
  ).evaluate(context());

  assert.ok(outcome.status === "evaluated");
  assert.deepEqual(outcome.findings, []);
});

test("borrows exceeding deposits is a breach, with provenance attached", async () => {
  const outcome = await rule(
    protocolReturning({
      markets: [
        { ...healthyMarket, totalDepositBalanceUSD: "1000", totalBorrowBalanceUSD: "1500" },
      ],
    }),
  ).evaluate(context());

  assert.ok(outcome.status === "evaluated");
  assert.equal(outcome.findings.length, 1);
  const [finding] = outcome.findings;
  assert.equal(finding?.severity, "critical");
  assert.equal(finding?.evidence["check"], "borrows_within_deposits");
  // A breach claim is only checkable if the reader knows who said so and how
  // stale they were.
  assert.equal(finding?.evidence["deployment_id"], "QmAave");
  assert.equal(finding?.evidence["effective_lag_seconds"], 4);
  assert.equal(finding?.evidence["derived_from"], "indexed_protocol_data");
});

test("a negative balance is a breach no accounting can produce", async () => {
  const outcome = await rule(
    protocolReturning({
      markets: [{ ...healthyMarket, totalValueLockedUSD: "-1" }],
    }),
  ).evaluate(context());

  assert.ok(outcome.status === "evaluated");
  assert.equal(outcome.findings[0]?.evidence["check"], "non_negative");
});

test("value locked with no underlying balance is a breach", async () => {
  const outcome = await rule(
    protocolReturning({
      markets: [{ ...healthyMarket, inputTokenBalance: "0" }],
    }),
  ).evaluate(context());

  assert.ok(outcome.status === "evaluated");
  assert.equal(
    outcome.findings[0]?.evidence["check"],
    "value_backed_by_balance",
  );
});

test("high utilisation alone is not a breach", async () => {
  const outcome = await rule(
    protocolReturning({
      markets: [
        // 99.9% utilised: alarming to a human, entirely possible, and firing
        // here would flag healthy markets during ordinary demand spikes.
        { ...healthyMarket, totalDepositBalanceUSD: "1000", totalBorrowBalanceUSD: "999" },
      ],
    }),
  ).evaluate(context());

  assert.ok(outcome.status === "evaluated");
  assert.deepEqual(outcome.findings, []);
});
