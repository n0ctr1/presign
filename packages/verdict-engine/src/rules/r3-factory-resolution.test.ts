import assert from "node:assert/strict";
import { test } from "node:test";

import { confirmedFactory, InvariantBreachRule } from "../../dist/index.js";
import type { UnsignedTransaction } from "../../dist/index.js";

/*
 * The shape measured on mainnet for the Uniswap V3 USDC/WETH 0.05% pool: the
 * registry's address lookup finds two deployments that do not speak the
 * schema and one whose only indexer is down, while the factory is indexed by a
 * conforming deployment six seconds behind head.
 */
const POOL = "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640";
const FACTORY = "0x1f98431c8ad98523631ae4a59f267346ea31f984";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const AGENT = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const T0 = new Date("2026-09-11T00:00:00Z");

const word = (hex: string) => `0x${hex.replace(/^0x/, "").padStart(64, "0")}`;

/** A fork that answers the pool's and the factory's getters. */
function chain(options: { getPoolAnswer?: string; fee?: boolean } = {}) {
  const calls: string[] = [];
  const call = (address: string, data: string) => {
    calls.push(`${address}:${data.slice(0, 10)}`);
    const at = address.toLowerCase();
    const selector = data.slice(0, 10);
    if (at === POOL && selector === "0xc45a0155") return Promise.resolve(word(FACTORY));
    if (at === POOL && selector === "0x0dfe1681") return Promise.resolve(word(USDC));
    if (at === POOL && selector === "0xd21220a7") return Promise.resolve(word(WETH));
    if (at === POOL && selector === "0xddca3f43") {
      return Promise.resolve(options.fee === false ? null : word((500).toString(16)));
    }
    if (at === FACTORY && (selector === "0x1698ee82" || selector === "0xe6a43905")) {
      return Promise.resolve(word(options.getPoolAnswer ?? POOL));
    }
    return Promise.resolve(null);
  };
  return { call, calls };
}

const context = (call: unknown) =>
  ({
    transaction: {
      from: AGENT,
      to: POOL,
      value: 0n,
      data: "0x",
      chainId: 1,
    } as UnsignedTransaction,
    diff: { pre: {}, post: {}, blockNumber: 1, revertReason: null },
    getStorageAt: () => Promise.reject(new Error("unused")),
    getCode: () => Promise.reject(new Error("unused")),
    call,
  }) as never;

const healthyPool = {
  id: POOL,
  name: "Uniswap V3 USD Coin/Wrapped Ether 0.05%",
  totalValueLockedUSD: "109267545",
  inputTokenBalances: ["60000000000000", "20000000000000000000000"],
  cumulativeVolumeUSD: "900000000000",
};

const record = (deploymentId: string, displayName: string) => ({
  candidate: { deploymentId, displayName, schemaFamily: "dex-amm", network: "mainnet" },
  conformance: { answersFields: [], missingFields: [] },
  liveness: { lagSeconds: 6, checkedAt: T0, indexedBlock: 25950000, hasIndexingErrors: false },
});

function protocol(options: { poolRow?: unknown } = {}) {
  const queries: string[] = [];
  const direct = { deploymentId: "QmBroken", displayName: "Uniswap-V3-ETH-contract", schemaFamily: "dex-amm", network: "mainnet" };
  const viaFactory = { deploymentId: "QmFactory", displayName: "Uniswap V3 Ethereum", schemaFamily: "dex-amm", network: "mainnet" };
  return {
    queries,
    context: {
      findIndexingDeployments: (address: string) =>
        Promise.resolve(address === POOL ? [direct] : address === FACTORY ? [viaFactory] : []),
      probeDeployment: (candidate: { deploymentId: string; displayName: string }) =>
        Promise.resolve(
          candidate.deploymentId === "QmBroken"
            ? { status: "failed", reason: "bad indexers: no status" }
            : { status: "probed", record: record(candidate.deploymentId, candidate.displayName) },
        ),
      query: (_id: string, text: string) => {
        queries.push(text);
        return Promise.resolve({
          liquidityPool: options.poolRow === undefined ? healthyPool : options.poolRow,
          _meta: { block: { number: 25950000, timestamp: T0.getTime() / 1000 - 6 }, hasIndexingErrors: false },
        });
      },
    } as never,
  };
}

const rule = (protocolContext: never) =>
  new InvariantBreachRule({ protocol: protocolContext, now: () => T0 });

test("a pool reaches the deployments indexing its factory, and is asked about by id", async () => {
  const { call } = chain();
  const p = protocol();

  const outcome = await rule(p.context).evaluate(context(call));

  // Before resolution this was `unavailable`: the only schema-capable lookup
  // failed, and the deployment that could answer was never considered.
  assert.ok(outcome.status === "evaluated");
  assert.deepEqual(outcome.findings, []);
  assert.equal(outcome.sources?.[0]?.deploymentId, "QmFactory");
  // This pool, not a sample of the protocol's largest pools.
  assert.equal(p.queries.length, 1);
  assert.match(p.queries[0]!, new RegExp(`liquidityPool\\(id: "${POOL}"[,)]`));
});

test("a breach in the resolved pool names the factory it was reached through", async () => {
  const { call } = chain();
  const p = protocol({
    poolRow: { ...healthyPool, inputTokenBalances: ["0", "0"] },
  });

  const outcome = await rule(p.context).evaluate(context(call));

  assert.ok(outcome.status === "evaluated");
  assert.equal(outcome.findings[0]?.severity, "critical");
  assert.deepEqual(outcome.findings[0]?.evidence["resolved_via"], {
    factory: FACTORY,
    confirmed_by: "getPool",
  });
});

test("a contract claiming a factory that does not vouch for it is not resolved", async () => {
  // Returning Uniswap's factory address costs an impostor nothing. The factory
  // naming a different pool for these tokens is what exposes it.
  const { call } = chain({ getPoolAnswer: "0x000000000000000000000000000000000000beef" });
  const p = protocol();

  const outcome = await rule(p.context).evaluate(context(call));

  assert.ok(outcome.status === "unavailable");
  assert.equal(outcome.reason, "probe_failed");
  assert.equal(p.queries.length, 0);
});

test("a fresh deployment that has not indexed this pool is not a clean pool", async () => {
  const { call } = chain();
  const p = protocol({ poolRow: null });

  const outcome = await rule(p.context).evaluate(context(call));

  assert.ok(outcome.status === "unavailable");
  assert.equal(outcome.reason, "query_failed");
  assert.match(outcome.detail, new RegExp(`holds no liquidityPool ${POOL}`));
});

test("a pair without a fee tier is confirmed through getPair", async () => {
  const { call, calls } = chain({ fee: false });

  assert.deepEqual(await confirmedFactory(POOL as never, call as never), {
    factory: FACTORY,
    confirmedBy: "getPair",
  });
  assert.ok(calls.includes(`${FACTORY}:0xe6a43905`));
});

test("an address that is not a pool costs one call and resolves to nothing", async () => {
  const calls: string[] = [];
  const call = (address: string, data: string) => {
    calls.push(`${address}:${data}`);
    return Promise.resolve(null);
  };

  assert.equal(await confirmedFactory(USDC as never, call as never), null);
  assert.equal(calls.length, 1);
});
