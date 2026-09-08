import assert from "node:assert/strict";
import { test } from "node:test";

import { ForkSimulator } from "../../dist/index.js";

const FORK_URL = "https://archive.example/key";

/**
 * An anvil that answers the three calls the refresh path makes, and records
 * the order they arrive in. `anvil_reset` moves the fork's block timestamp to
 * "now", which is what makes the fork fresh again.
 */
function anvil(options: { blockAgeSeconds: number; now: () => Date }) {
  const calls: string[] = [];
  let blockTimestamp = Math.floor(options.now().getTime() / 1000) - options.blockAgeSeconds;

  const fetchImpl = (async (_url: string, init: { body: string }) => {
    const { method } = JSON.parse(init.body) as { method: string };
    calls.push(method);
    if (method === "anvil_reset") {
      blockTimestamp = Math.floor(options.now().getTime() / 1000);
      return jsonOk(null);
    }
    if (method === "eth_getBlockByNumber") {
      return jsonOk({ timestamp: `0x${blockTimestamp.toString(16)}` });
    }
    return jsonOk("0x0");
  }) as unknown as typeof globalThis.fetch;

  const jsonOk = (result: unknown) => ({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ jsonrpc: "2.0", id: 1, result }),
  });

  return { fetch: fetchImpl, calls, resets: () => calls.filter((c) => c === "anvil_reset").length };
}

const NOW = new Date("2026-09-08T04:00:00Z");

test("a fork inside its age is left alone", async () => {
  const node = anvil({ blockAgeSeconds: 20, now: () => NOW });
  const simulator = new ForkSimulator("http://fork.test", {
    maxForkAgeSeconds: 60,
    forkUrl: FORK_URL,
    now: () => NOW,
    fetch: node.fetch,
  });

  await simulator.withFreshFork(() => Promise.resolve("done"));

  assert.equal(node.resets(), 0);
});

test("a fork past its age is re-forked before the verdict runs", async () => {
  const node = anvil({ blockAgeSeconds: 3600, now: () => NOW });
  const simulator = new ForkSimulator("http://fork.test", {
    maxForkAgeSeconds: 60,
    forkUrl: FORK_URL,
    now: () => NOW,
    fetch: node.fetch,
  });

  const order: string[] = [];
  await simulator.withFreshFork(() => {
    order.push("verdict");
    return Promise.resolve();
  });

  assert.equal(node.resets(), 1);
  // The reset lands before the verdict starts, never during it.
  assert.equal(node.calls.indexOf("anvil_reset") < node.calls.length, true);
  assert.deepEqual(order, ["verdict"]);
});

test("verdicts run alongside each other; only a reset is exclusive", async () => {
  const node = anvil({ blockAgeSeconds: 3600, now: () => NOW });
  const simulator = new ForkSimulator("http://fork.test", {
    maxForkAgeSeconds: 60,
    forkUrl: FORK_URL,
    now: () => NOW,
    fetch: node.fetch,
  });

  const events: string[] = [];
  let releaseFirst: () => void = () => {};
  const firstHolds = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = simulator.withFreshFork(async () => {
    events.push("first-start");
    await firstHolds;
    events.push("first-end");
  });
  await new Promise((resolve) => setTimeout(resolve, 5));

  // The first verdict re-forked, so the fork is fresh and the second has no
  // reason to wait. Serialising verdicts would cost throughput for nothing:
  // reading the same pinned block concurrently is safe, moving it is not.
  const second = simulator.withFreshFork(() => {
    events.push("second");
    return Promise.resolve();
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  releaseFirst();
  await Promise.all([first, second]);

  assert.deepEqual(events, ["first-start", "second", "first-end"]);
  assert.equal(node.resets(), 1);
});

test("a reset waits for the verdict already reading the fork", async () => {
  let clock = NOW;
  const node = anvil({ blockAgeSeconds: 0, now: () => clock });
  const simulator = new ForkSimulator("http://fork.test", {
    maxForkAgeSeconds: 60,
    forkUrl: FORK_URL,
    now: () => clock,
    fetch: node.fetch,
  });

  const events: string[] = [];
  let releaseFirst: () => void = () => {};
  const firstHolds = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = simulator.withFreshFork(async () => {
    events.push("first-start");
    await firstHolds;
    events.push("first-end");
  });
  await new Promise((resolve) => setTimeout(resolve, 5));

  // An hour passes while the first verdict is still in flight, so the second
  // arrives to a stale fork and must re-fork before it can run.
  clock = new Date(NOW.getTime() + 3600_000);
  const second = simulator.withFreshFork(() => {
    events.push("second");
    return Promise.resolve();
  });
  await new Promise((resolve) => setTimeout(resolve, 5));

  // Nothing has moved yet: resetting now would shift the state under a verdict
  // that has already taken its diff and is still reading storage from it.
  assert.equal(node.resets(), 0);
  assert.deepEqual(events, ["first-start"]);

  releaseFirst();
  await Promise.all([first, second]);

  assert.equal(node.resets(), 1);
  assert.deepEqual(events, ["first-start", "first-end", "second"]);
});

test("asking to re-fork without an upstream to re-fork from is a construction error", () => {
  // Failing here beats discovering it as a simulation failure an hour into a
  // long-running service, which is exactly when the first refresh is due.
  assert.throws(
    () => new ForkSimulator("http://fork.test", { maxForkAgeSeconds: 60 }),
    /forkUrl/,
  );
});
