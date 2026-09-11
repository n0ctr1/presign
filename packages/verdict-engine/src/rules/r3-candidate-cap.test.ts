import assert from "node:assert/strict";
import { test } from "node:test";

import { InvariantBreachRule, MAX_INVARIANT_CANDIDATES } from "../../dist/index.js";
import type { UnsignedTransaction } from "../../dist/index.js";

const TARGET = "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2";
const T0 = new Date("2026-09-11T12:00:00Z");

const context = {
  transaction: {
    from: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    to: TARGET,
    value: 0n,
    data: "0x",
    chainId: 1,
  } as UnsignedTransaction,
  diff: { pre: {}, post: {}, blockNumber: 1, revertReason: null },
  getStorageAt: () => Promise.reject(new Error("unused")),
  getCode: () => Promise.reject(new Error("unused")),
  call: () => Promise.resolve(null),
} as never;

/** A registry naming `count` deployments, the first `conformingAt` of which speak the schema. */
function crowded(count: number, conformingAt: number | null) {
  const probed: string[] = [];
  const candidates = Array.from({ length: count }, (_, i) => ({
    deploymentId: `Qm${i}`,
    displayName: `deployment ${i}`,
    schemaFamily: "lending-cdp",
    network: "mainnet",
  }));
  return {
    probed,
    protocol: {
      findIndexingDeployments: () => Promise.resolve(candidates),
      probeDeployment: (candidate: { deploymentId: string }) => {
        probed.push(candidate.deploymentId);
        const index = Number(candidate.deploymentId.slice(2));
        return Promise.resolve({
          status: "probed",
          record: {
            candidate,
            conformance: {
              answersFields: [],
              missingFields: conformingAt !== null && index === conformingAt ? [] : ["totalBorrowBalanceUSD"],
            },
            liveness: { lagSeconds: 4, checkedAt: T0, indexedBlock: 1, hasIndexingErrors: false },
          },
        });
      },
      query: () =>
        Promise.resolve({
          markets: [],
          _meta: { block: { number: 1, timestamp: T0.getTime() / 1000 - 4 }, hasIndexingErrors: false },
        }),
    } as never,
  };
}

test("probes no more deployments than the price covers", async () => {
  const world = crowded(40, 2);

  const outcome = await new InvariantBreachRule({ protocol: world.protocol, now: () => T0 }).evaluate(context);

  // Anyone can publish a subgraph naming any address; forty of them must not
  // cost forty probes against a price that stops at eight.
  assert.equal(world.probed.length, MAX_INVARIANT_CANDIDATES);
  assert.ok(outcome.status === "evaluated");
});

test("a ceiling reached with nothing conforming is unavailable, not a clean answer", async () => {
  // The one conforming deployment sits past the ceiling.
  const world = crowded(12, 10);

  const outcome = await new InvariantBreachRule({ protocol: world.protocol, now: () => T0 }).evaluate(context);

  assert.ok(outcome.status === "unavailable");
  assert.equal(outcome.reason, "too_many_candidates");
  assert.match(outcome.detail, /12 deployments.*other 4 could is unknown/);
});

test("under the ceiling, nothing conforming is still nothing to check", async () => {
  const world = crowded(3, null);

  const outcome = await new InvariantBreachRule({ protocol: world.protocol, now: () => T0 }).evaluate(context);

  assert.ok(outcome.status === "evaluated");
  assert.deepEqual(outcome.findings, []);
});
