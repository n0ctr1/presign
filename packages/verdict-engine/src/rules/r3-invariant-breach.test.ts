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
  deployments?: number;
  markets?: unknown[];
  queryThrows?: string;
  probeFails?: string;
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
        setup.probeFails !== undefined
          ? { status: "failed", reason: setup.probeFails }
          : {
              status: "probed",
              record: {
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
    probeDeployment: () => Promise.reject(new Error("unused")),
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

test("every probe failing is unavailable, never a clean protocol", async () => {
  /*
   * The regression this exists for, found by funding queries with a wallet
   * that had no money in it. Every probe was refused, R3 had been treating an
   * unreachable deployment identically to one that does not conform, and a
   * call to Aave came back `low` with no source named — a green verdict
   * resting entirely on data nobody ever saw.
   */
  const outcome = await rule(
    protocolWith({ probeFails: "payment was refused: insufficient_balance" }),
  ).evaluate(context());

  assert.ok(outcome.status === "unavailable");
  assert.equal(outcome.reason, "probe_failed");
  assert.match(outcome.detail, /insufficient_balance/);
});

test("a probe that completes and does not conform is still nothing to say", async () => {
  // The other half of the distinction: here we did ask, and the answer was
  // that this deployment cannot speak for the protocol. That is a fact about
  // the counterparty, and an empty result is the honest report of it.
  const outcome = await rule(
    protocolWith({ missingFields: ["totalDepositBalanceUSD"] }),
  ).evaluate(context());

  assert.ok(outcome.status === "evaluated");
  assert.deepEqual(outcome.findings, []);
});

test("a deployment that times out hands over to the next fresh one", async () => {
  /*
   * Measured against the Uniswap V3 factory: the freshest deployment
   * indexing it timed out on the data query, and R3 answered `unavailable`
   * while a second deployment — same schema, four seconds behind head — sat
   * one place down the ranking. Refusing there is not caution, it is a
   * refusal we had the data to avoid.
   */
  let attempt = 0;
  const protocol = {
    ...protocolWith({ deployments: 2 }),
    query: () => {
      attempt += 1;
      return attempt === 1
        ? Promise.reject(new Error("The operation was aborted due to timeout"))
        : Promise.resolve({ markets: [healthyMarket] });
    },
  } as never;

  const outcome = await rule(protocol).evaluate(context());

  assert.ok(outcome.status === "evaluated");
  assert.equal(attempt, 2);
  // The verdict still names what answered, so the fallback is visible rather
  // than silently papering over the first deployment's failure.
  assert.equal(outcome.sources?.length, 1);
});

test("every fresh deployment failing is still unavailable, and says which", async () => {
  const protocol = {
    ...protocolWith({ deployments: 2 }),
    query: () => Promise.reject(new Error("gateway exploded")),
  } as never;

  const outcome = await rule(protocol).evaluate(context());

  assert.ok(outcome.status === "unavailable");
  assert.equal(outcome.reason, "query_failed");
  // Naming the deployments that failed is the difference between an operator
  // who can act and one who can only re-run it and hope.
  assert.match(outcome.detail, /none of 2 fresh deployment/);
  assert.match(outcome.detail, /gateway exploded/);
});
