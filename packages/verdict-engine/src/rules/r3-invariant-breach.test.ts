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

const healthyMarket = {
  id: "0x4d5f47fa6a74757f35c14fd3a6ef8e3c9bc514e8",
  name: "Aave Ethereum WETH",
  totalValueLockedUSD: "5381128522.62",
  totalDepositBalanceUSD: "5381128522.62",
  totalBorrowBalanceUSD: "4437373949.91",
  inputTokenBalance: "2150241868832575325029252",
};

interface Setup {
  family?: string | null;
  missingFields?: string[];
  lagSeconds?: number;
  indexingErrors?: boolean;
  probeReturnsNull?: boolean;
  deployments?: number;
  markets?: unknown[];
  queryThrows?: string;
}

function protocolWith(setup: Setup) {
  const candidate = {
    deploymentId: "QmAave",
    displayName: "Aave V3 Ethereum",
    schemaFamily: setup.family === undefined ? "lending-cdp" : setup.family,
    network: "mainnet",
  };
  return {
    findIndexingDeployments: () =>
      Promise.resolve(Array((setup.deployments ?? 1)).fill(candidate)),
    probeDeployment: () =>
      Promise.resolve(
        setup.probeReturnsNull === true
          ? null
          : {
              candidate,
              conformance: {
                answersFields: [],
                missingFields: setup.missingFields ?? [],
              },
              liveness: {
                lagSeconds: setup.lagSeconds ?? 4,
                checkedAt: T0,
                indexedBlock: 25916120,
                hasIndexingErrors: setup.indexingErrors ?? false,
              },
            },
      ),
    query: () =>
      setup.queryThrows !== undefined
        ? Promise.reject(new Error(setup.queryThrows))
        : Promise.resolve({ markets: setup.markets ?? [healthyMarket] }),
  } as never;
}

const rule = (protocol: never, maxLagSeconds?: number) =>
  new InvariantBreachRule({
    protocol,
    now: () => T0,
    ...(maxLagSeconds === undefined ? {} : { maxLagSeconds }),
  });

test("an unconfigured chain is unavailable rather than silently skipped", async () => {
  const outcome = await rule(protocolWith({})).evaluate(
    context(tx({ chainId: 999_999 })),
  );

  assert.ok(outcome.status === "unavailable");
  assert.equal(outcome.reason, "unsupported_network");
});

test("nothing indexes the counterparty, so R3 has nothing to say", async () => {
  const protocol = {
    findIndexingDeployments: () => Promise.resolve([]),
    probeDeployment: () => Promise.resolve(null),
    query: () => Promise.reject(new Error("unused")),
  } as never;

  const outcome = await rule(protocol).evaluate(context());

  assert.ok(outcome.status === "evaluated");
  assert.deepEqual(outcome.findings, []);
});

test("a deployment claiming a family it cannot answer is not a protocol instance", async () => {
  // USDC's real shape: indexed by Hop's and SOMA's subgraphs, one of which is
  // classified dex-amm. Appearing in a manifest does not make a token a DEX,
  // and the give-away is that the deployment cannot answer the family's
  // fields. Conformance answers "what is this", so a miss means the
  // classification is unreliable — not that a protocol is in trouble.
  const outcome = await rule(
    protocolWith({ family: "dex-amm", missingFields: ["inputTokenBalances"] }),
  ).evaluate(context());

  assert.ok(outcome.status === "evaluated");
  assert.deepEqual(outcome.findings, []);
});

test("a conforming but stale deployment is unavailable, not silently skipped", async () => {
  // Liveness answers a different question from conformance: this *is* the
  // protocol, and we currently cannot see it. That is the fail-closed case.
  const outcome = await rule(protocolWith({ lagSeconds: 4000 })).evaluate(context());

  assert.ok(outcome.status === "unavailable");
  assert.equal(outcome.reason, "all_candidates_stale");
  assert.match(outcome.detail, /lending-cdp schema/);
});

test("a caller-tightened budget makes a fresh deployment stale, and says so", async () => {
  const outcome = await rule(protocolWith({ lagSeconds: 4 }), 1).evaluate(context());

  assert.ok(outcome.status === "unavailable");
  // The diagnostic must quote the budget actually enforced, or it sends an
  // operator looking for the wrong problem.
  assert.match(outcome.detail, /within 1s of chain head/);
});

test("a deployment reporting indexing errors is not used", async () => {
  const outcome = await rule(protocolWith({ indexingErrors: true })).evaluate(context());

  assert.ok(outcome.status === "evaluated");
  assert.deepEqual(outcome.findings, []);
});

test("a failed query is unavailable, not a healthy protocol", async () => {
  const outcome = await rule(
    protocolWith({ queryThrows: "gateway timeout" }),
  ).evaluate(context());

  assert.ok(outcome.status === "unavailable");
  assert.equal(outcome.reason, "query_failed");
});

test("a healthy protocol yields no findings but still names its source", async () => {
  const outcome = await rule(protocolWith({})).evaluate(context());

  assert.ok(outcome.status === "evaluated");
  assert.deepEqual(outcome.findings, []);
  // Without this, the "no breach" half of a verdict is unfalsifiable.
  assert.equal(outcome.sources?.[0]?.deploymentId, "QmAave");
  assert.equal(outcome.sources?.[0]?.effectiveLagSeconds, 4);
});

test("borrows exceeding deposits is a breach, with provenance attached", async () => {
  const outcome = await rule(
    protocolWith({
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
  assert.equal(finding?.evidence["deployment_id"], "QmAave");
  assert.equal(finding?.evidence["effective_lag_seconds"], 4);
});

test("a negative balance is a breach no accounting can produce", async () => {
  const outcome = await rule(
    protocolWith({ markets: [{ ...healthyMarket, totalValueLockedUSD: "-1" }] }),
  ).evaluate(context());

  assert.ok(outcome.status === "evaluated");
  assert.equal(outcome.findings[0]?.evidence["check"], "non_negative");
});

test("value locked with no underlying balance is a breach", async () => {
  const outcome = await rule(
    protocolWith({ markets: [{ ...healthyMarket, inputTokenBalance: "0" }] }),
  ).evaluate(context());

  assert.ok(outcome.status === "evaluated");
  assert.equal(outcome.findings[0]?.evidence["check"], "value_backed_by_balance");
});

test("high utilisation alone is not a breach", async () => {
  const outcome = await rule(
    protocolWith({
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
