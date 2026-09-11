import assert from "node:assert/strict";
import { test } from "node:test";

import { ForkSimulator } from "../../dist/index.js";
import type { UnsignedTransaction } from "../../dist/index.js";

const NOW = new Date("2026-09-11T20:00:00Z");
const tx = {
  from: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  to: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  value: 0n,
  data: "0x095ea7b3",
  chainId: 1,
} as UnsignedTransaction;

const reply = (body: unknown) => ({
  ok: true,
  status: 200,
  json: () => Promise.resolve({ jsonrpc: "2.0", id: 1, ...(body as object) }),
});

/** A node whose `eth_call` answers as asked and everything else succeeds. */
function node(ethCall: "ok" | "revert" | "timeout" | "missing-trie") {
  return (async (_url: string, init: { body: string }) => {
    const { method } = JSON.parse(init.body) as { method: string };
    if (method === "eth_call") {
      if (ethCall === "timeout") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      if (ethCall === "revert") return reply({ error: { code: 3, message: "execution reverted" } });
      if (ethCall === "missing-trie") return reply({ error: { code: -32000, message: "missing trie node abc" } });
      return reply({ result: "0x" });
    }
    if (method === "eth_blockNumber") return reply({ result: "0x100" });
    if (method === "eth_getBlockByNumber") return reply({ result: { timestamp: `0x${(NOW.getTime() / 1000).toString(16)}` } });
    if (method === "debug_traceCall") return reply({ result: { pre: {}, post: {} } });
    return reply({ result: null });
  }) as unknown as typeof globalThis.fetch;
}

const simulate = (ethCall: Parameters<typeof node>[0]) =>
  new ForkSimulator("http://fork.test", { fetch: node(ethCall), now: () => NOW }).simulate(tx);

test("a node saying the execution reverted is a revert", async () => {
  const diff = await simulate("revert");
  assert.match(String(diff.revertReason), /execution reverted/);
});

test("a timeout is not a revert, and the simulation fails rather than reading as one", async () => {
  // Read as a revert, a slow RPC used to silence R1 and turn an unlimited
  // approval to an attacker into `low`.
  await assert.rejects(simulate("timeout"), /simulation failed: eth_call/);
});

test("a node that could not serve the state is not a revert either", async () => {
  await assert.rejects(simulate("missing-trie"), /missing trie node/);
});

test("a read-only call that reverts answers null, and one that times out throws", async () => {
  const call = (ethCall: Parameters<typeof node>[0]) =>
    new ForkSimulator("http://fork.test", { fetch: node(ethCall), now: () => NOW }).call(tx.to!, "0x18160ddd");

  // Rules probe interfaces a contract may not have, so a revert is a normal
  // "no". A node failing is not, and R1 reading it as "no total supply" would
  // let a 2^127 approval through.
  assert.equal(await call("revert"), null);
  await assert.rejects(call("timeout"));
  await assert.rejects(call("missing-trie"), /missing trie node/);
});

test("verdicts arriving together at a stale fork share one reset, and none reads during it", async () => {
  let forkTimestamp = NOW.getTime() / 1000 - 3600;
  let resetting = false;
  let resets = 0;
  const readsDuringReset: string[] = [];

  const fetchImpl = (async (_url: string, init: { body: string }) => {
    const { method } = JSON.parse(init.body) as { method: string };
    if (method === "anvil_reset") {
      resets += 1;
      resetting = true;
      await new Promise((resolve) => setTimeout(resolve, 20));
      forkTimestamp = NOW.getTime() / 1000;
      resetting = false;
      return reply({ result: null });
    }
    if (method === "eth_getBlockByNumber") {
      await new Promise((resolve) => setTimeout(resolve, 2));
      return reply({ result: { timestamp: `0x${Math.floor(forkTimestamp).toString(16)}` } });
    }
    return reply({ result: null });
  }) as unknown as typeof globalThis.fetch;

  const simulator = new ForkSimulator("http://fork.test", {
    maxForkAgeSeconds: 60,
    forkUrl: "https://archive.example/key",
    now: () => NOW,
    fetch: fetchImpl,
  });

  const verdict = (name: string) =>
    simulator.withFreshFork(async () => {
      if (resetting) readsDuringReset.push(name);
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (resetting) readsDuringReset.push(name);
    });

  // Both read the fork's age before either starts a reset. The earlier code
  // let both reset, and the second landed inside the first verdict.
  await Promise.all([verdict("a"), verdict("b"), verdict("c")]);

  assert.equal(resets, 1);
  assert.deepEqual(readsDuringReset, []);
});
