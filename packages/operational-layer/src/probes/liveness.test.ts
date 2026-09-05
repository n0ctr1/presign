import assert from "node:assert/strict";
import { test } from "node:test";

import {
  GatewayClient,
  GatewayQueryError,
  LivenessProbe,
} from "../../dist/index.js";

/** Gateway wired to a canned HTTP response, so no network is involved. */
function gatewayReturning(body: unknown, status = 200): GatewayClient {
  return new GatewayClient({
    apiKey: () => Promise.resolve("test-key"),
    fetch: () =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
      ) as unknown as ReturnType<typeof globalThis.fetch>,
  });
}

const chainHead = (number: number, timestamp: number) => ({
  headBlock: () => Promise.resolve({ number, timestamp }),
});

function metaBody(block: number, timestamp: number, hasIndexingErrors: unknown) {
  return { data: { _meta: { block: { number: block, timestamp }, hasIndexingErrors } } };
}

test("reports blocks behind and data age as separate numbers", async () => {
  const probe = new LivenessProbe({
    gateway: gatewayReturning(metaBody(1000, 1_700_000_000, false)),
    chainHead: chainHead(1010, 1_700_000_120),
    now: () => new Date(1_700_000_120_000),
  });

  const report = await probe.check("QmTest", "mainnet");

  assert.equal(report.blocksBehind, 10);
  assert.equal(report.lagSeconds, 120);
  assert.equal(report.hasIndexingErrors, false);
});

test("a stalled chain ages the data without blaming the indexer", async () => {
  // Indexer is exactly at head, but the newest block is an hour old.
  const probe = new LivenessProbe({
    gateway: gatewayReturning(metaBody(1000, 1_700_000_000, false)),
    chainHead: chainHead(1000, 1_700_000_000),
    now: () => new Date(1_700_003_600_000),
  });

  const report = await probe.check("QmTest", "mainnet");

  assert.equal(report.blocksBehind, 0);
  assert.equal(report.lagSeconds, 3600);
});

test("clamps negative lag from a reorg or a lagging RPC", async () => {
  const probe = new LivenessProbe({
    gateway: gatewayReturning(metaBody(1010, 1_700_000_120, false)),
    chainHead: chainHead(1000, 1_700_000_000),
    now: () => new Date(1_700_000_000_000),
  });

  const report = await probe.check("QmTest", "mainnet");

  assert.equal(report.blocksBehind, 0);
  assert.equal(report.lagSeconds, 0);
});

test("treats an absent hasIndexingErrors as erroring", async () => {
  const probe = new LivenessProbe({
    gateway: gatewayReturning(metaBody(1000, 1_700_000_000, undefined)),
    chainHead: chainHead(1000, 1_700_000_000),
    now: () => new Date(1_700_000_000_000),
  });

  // graph-node always sends the field. Its absence means we are not talking to
  // what we think we are, and only the fail-closed reading is safe.
  assert.equal((await probe.check("QmTest", "mainnet")).hasIndexingErrors, true);
});

test("rejects an HTTP 200 carrying a GraphQL error body", async () => {
  const probe = new LivenessProbe({
    gateway: gatewayReturning({ errors: [{ message: "auth error: missing key" }] }),
    chainHead: chainHead(1000, 1_700_000_000),
  });

  // The gateway reports auth failures as 200. Reading the status alone would
  // turn a broken key into a successful empty result.
  await assert.rejects(
    () => probe.check("QmTest", "mainnet"),
    (error: unknown) => {
      assert.ok(error instanceof GatewayQueryError);
      assert.deepEqual(error.graphqlErrors, ["auth error: missing key"]);
      return true;
    },
  );
});

test("rejects a deployment that answers _meta with no block", async () => {
  const probe = new LivenessProbe({
    gateway: gatewayReturning({ data: { _meta: null } }),
    chainHead: chainHead(1000, 1_700_000_000),
  });

  await assert.rejects(() => probe.check("QmTest", "mainnet"), TypeError);
});
