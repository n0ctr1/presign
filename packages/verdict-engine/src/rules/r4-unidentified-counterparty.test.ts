import assert from "node:assert/strict";
import { test } from "node:test";

import {
  RpcContractOrigin,
  UnidentifiedCounterpartyRule,
  VerdictEngine,
} from "../../dist/index.js";
import type { ContractOrigin, UnsignedTransaction } from "../../dist/index.js";

const NOW = new Date("2026-09-07T12:00:00Z");
const AGENT = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const UNKNOWN = "0x00000000000000000000000000000000000c0ffee";
const AAVE_V3_POOL = "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2";
const CODE = "0x60806040523480156100";

const approve = `0x095ea7b3${"0".repeat(24)}${AGENT.slice(2)}${"f".repeat(64)}`;

const secondsAgo = (seconds: number) => Math.floor(NOW.getTime() / 1000) - seconds;

function transaction(over: Partial<UnsignedTransaction> = {}): UnsignedTransaction {
  return {
    from: AGENT,
    to: UNKNOWN,
    value: 0n,
    data: approve,
    chainId: 1,
    ...over,
  } as UnsignedTransaction;
}

/** Only `getCode` matters to R4; anything else it reaches for is a defect. */
const context = (tx: UnsignedTransaction, code = CODE) =>
  ({
    transaction: tx,
    diff: { pre: {}, post: {}, blockNumber: 25916120, revertReason: null },
    getCode: () => Promise.resolve(code),
    getStorageAt: () => Promise.reject(new Error("R4 must not read storage")),
    call: () => Promise.reject(new Error("R4 must not call the counterparty")),
  }) as never;

const directory = (deployments: readonly unknown[] | Error) => ({
  findIndexingDeployments: () =>
    deployments instanceof Error
      ? Promise.reject(deployments)
      : Promise.resolve(deployments),
});

const originOf = (origin: ContractOrigin) => ({
  originOf: () => Promise.resolve(origin),
});

const rule = (
  deployments: readonly unknown[] | Error,
  origin: ContractOrigin = { status: "deployed", block: 25_916_000, timestamp: secondsAgo(3600) },
) =>
  new UnidentifiedCounterpartyRule({
    directory: directory(deployments) as never,
    origin: originOf(origin) as never,
    now: () => NOW,
  });

type Outcome = {
  status: string;
  reason?: string;
  findings?: readonly {
    ruleId: string;
    severity: string;
    standing?: boolean;
    title: string;
    detail: string;
    evidence: Record<string, unknown>;
  }[];
};

const evaluate = async (r: ReturnType<typeof rule>, ctx: never) =>
  (await r.evaluate(ctx)) as unknown as Outcome;

test("a counterparty some deployment indexes produces no finding", async () => {
  const outcome = await evaluate(
    rule([{ deploymentId: "Qm...", displayName: "Aave V3" }]),
    context(transaction({ to: AAVE_V3_POOL })),
  );

  assert.equal(outcome.status, "evaluated");
  assert.deepEqual(outcome.findings, []);
});

test("an unindexed contract deployed an hour ago is critical", async () => {
  const outcome = await evaluate(rule([]), context(transaction()));

  assert.equal(outcome.status, "evaluated");
  const [finding] = outcome.findings!;
  assert.equal(finding!.severity, "critical");
  assert.equal(finding!.standing, true);
  assert.match(finding!.title, /deployed 60 minutes ago/);
  assert.equal(finding!.evidence["indexing_deployments"], 0);
  assert.equal(finding!.evidence["age_bound"], "deployed");
  assert.equal(finding!.evidence["age_seconds"], 3600);
});

test("this is the gap that used to return low: the engine tiers it high", async () => {
  const engine = new VerdictEngine({
    simulator: {
      chainId: () => Promise.resolve(1),
      withFreshFork: <T>(work: () => Promise<T>) => work(),
      simulate: () =>
        Promise.resolve({ pre: {}, post: {}, blockNumber: 25916120, revertReason: null }),
      asRuleReaders: () => ({
        getCode: () => Promise.resolve(CODE),
        getStorageAt: () => Promise.resolve("0x"),
        call: () => Promise.resolve(null),
      }),
    } as never,
    rules: [rule([])],
    now: () => NOW,
  });

  const verdict = await engine.evaluate(transaction());

  // Standing findings from R4 are deliberately left uncapped, unlike R2's:
  // "unindexed and deployed this morning" is not true of ordinary DeFi.
  assert.equal(verdict.tier, "high");
  assert.match(verdict.action, /do not sign/i);
});

test("an old unindexed contract is reported without raising the tier", async () => {
  /*
   * Measured against contracts nobody disputes: Multicall3, Permit2 and
   * Uniswap's router are indexed by nothing, and every one of them is
   * ordinary. Indexing tracks whether a contract emits events worth querying,
   * not whether it can be trusted, so charging a human confirmation for
   * absence charges it to the contracts an agent meets most often.
   */
  const outcome = await evaluate(
    rule([], { status: "older_than", block: 25_000_000, timestamp: secondsAgo(90 * 24 * 3600) }),
    context(transaction()),
  );

  const [finding] = outcome.findings!;
  assert.equal(finding!.severity, "info");
  assert.equal(finding!.evidence["age_bound"], "older_than");
  // A bound, not a birthday: the search found code at this block and stopped,
  // so nothing was deployed here and the field must not claim otherwise.
  assert.equal(finding!.evidence["origin_block"], 25_000_000);
  assert.match(finding!.detail, /not a fresh deployment/);
});

test("an age that could not be established is never read as fresh, nor as old", async () => {
  const outcome = await evaluate(
    rule([], { status: "indeterminate", reason: "eth_getCode: HTTP 429" }),
    context(transaction()),
  );

  const [finding] = outcome.findings!;
  // Inventing `high` out of an RPC timeout would mirror the fail-open this
  // rule closes. Treating it like an old contract was the other mistake: a
  // timeout on the age search turned a contract deployed an hour ago into
  // `low`. Unknown is `warning`, which puts a human in front of it.
  assert.equal(finding!.severity, "warning");
  assert.match(finding!.title, /unknown age/);
  assert.equal(finding!.evidence["age_seconds"], null);
  assert.equal(finding!.evidence["origin_block"], null);
  assert.match(finding!.detail, /unknown rather than long/);
});

test("a registry that cannot be reached is unavailable, not a verdict either way", async () => {
  const outcome = await evaluate(
    rule(new Error("registry timed out")),
    context(transaction()),
  );

  assert.equal(outcome.status, "unavailable");
  assert.equal(outcome.reason, "identification_unavailable");
});

test("a familiar selector on an unidentified contract is reported as convention only", async () => {
  const outcome = await evaluate(rule([]), context(transaction()));

  const [finding] = outcome.findings!;
  assert.equal(finding!.evidence["selector"], "0x095ea7b3");
  assert.equal(finding!.evidence["selector_convention"], "approve(address,uint256)");
  assert.match(finding!.detail, /by convention only/);
});

/*
 * EIP-7702. `eth_getCode` on a delegated account returns `0xef0100 || delegate`,
 * so an account looks exactly like a small contract to anything that only asks
 * whether code is present. Vitalik's account returns 23 bytes on mainnet today.
 * Without these cases R4 would report every smart account as an unidentified
 * contract — and agent wallets, which this project exists to advise, are the
 * accounts most likely to carry a delegation.
 */
const DELEGATE = "0x5a7fc11397e9a8ad41bf10bf13f22b0a63f96f6d";
const delegationCode = (to: string) => `0xef0100${to.slice(2)}`;

test("a delegated account is identified by its delegate, not by the account", async () => {
  const seen: string[] = [];
  const r = new UnidentifiedCounterpartyRule({
    directory: {
      findIndexingDeployments: (address: string) => {
        seen.push(address);
        return Promise.resolve([{ deploymentId: "Qm...", displayName: "wallet impl" }]);
      },
    } as never,
    origin: originOf({ status: "older_than", block: 1, timestamp: secondsAgo(1e6) }) as never,
    now: () => NOW,
  });

  const outcome = (await r.evaluate(
    context(transaction(), delegationCode(DELEGATE)),
  )) as unknown as Outcome;

  assert.deepEqual(seen, [DELEGATE]);
  // The delegate is indexed, so the only thing left to say is that this is a
  // delegated account at all — and that alone must not move the tier.
  assert.equal(outcome.findings!.length, 1);
  assert.equal(outcome.findings![0]!.severity, "info");
  assert.equal(outcome.findings![0]!.evidence["delegate"], DELEGATE);
});

test("a wallet delegated to a contract nobody has indexed is judged on the delegate", async () => {
  const r = new UnidentifiedCounterpartyRule({
    directory: directory([]) as never,
    origin: originOf({ status: "deployed", block: 25_916_000, timestamp: secondsAgo(1800) }) as never,
    now: () => NOW,
  });

  const outcome = (await r.evaluate(
    context(transaction(), delegationCode(DELEGATE)),
  )) as unknown as Outcome;

  const unidentified = outcome.findings!.find((f) => f.severity === "critical")!;
  // The shape of a 7702 hijack: the account is ordinary, the delegation is new,
  // and the thing it points at has no public record at all.
  assert.equal(unidentified.evidence["identified_subject"], DELEGATE);
  assert.equal(unidentified.evidence["delegated"], true);
  assert.equal(unidentified.evidence["counterparty"], UNKNOWN);
  assert.match(unidentified.detail, /the contract .* delegates to/);
});

test("a cleared delegation is an ordinary account again, not a contract", async () => {
  const outcome = await evaluate(
    rule([]),
    context(transaction(), delegationCode(`0x${"0".repeat(40)}`)),
  );

  // Nothing executes at a zero delegation, so there is no counterparty to
  // identify; the finding is the ordinary "calldata to an address that cannot
  // run it", not an unidentified contract.
  const [finding] = outcome.findings!;
  assert.match(finding!.title, /no code/);
});

test("calldata sent to an address with no code is reported", async () => {
  const outcome = await evaluate(rule([]), context(transaction(), "0x"));

  const [finding] = outcome.findings!;
  assert.equal(finding!.severity, "warning");
  // About this call, not a standing property of an account that holds nothing.
  assert.equal(finding!.standing, false);
  assert.match(finding!.title, /no code/);
  assert.equal(finding!.evidence["counterparty_code_size_bytes"], 0);
});

test("a plain value transfer to an account with no code is not a finding", async () => {
  const outcome = await evaluate(
    rule([]),
    context(transaction({ data: "0x", value: 10n ** 18n }), "0x"),
  );

  assert.deepEqual(outcome.findings, []);
});

test("contract creation has no counterparty to identify", async () => {
  const outcome = await evaluate(rule([]), context(transaction({ to: null })));

  assert.equal(outcome.status, "evaluated");
  assert.deepEqual(outcome.findings, []);
});

test("a chain with no configured registry is unavailable, not clean", async () => {
  const outcome = await evaluate(rule([]), context(transaction({ chainId: 999 })));

  assert.equal(outcome.status, "unavailable");
  assert.equal(outcome.reason, "unsupported_network");
});

/* ------------------------------------------------------------------ origin */

const GENESIS = 1_600_000_000;

function chain(options: {
  head: number;
  secondsPerBlock: number;
  deployedAt: number | null;
  failMethod?: string;
}) {
  const codeProbes: number[] = [];
  const blockProbes: number[] = [];
  const fetch = (async (_url: string, init: { body: string }) => {
    const { method, params } = JSON.parse(init.body) as {
      method: string;
      params: unknown[];
    };
    if (method === options.failMethod) {
      return { ok: false, status: 503, json: () => Promise.resolve({}) };
    }
    if (method === "eth_getBlockByNumber") {
      const tag = params[0] as string;
      const n = tag === "latest" ? options.head : Number.parseInt(tag, 16);
      blockProbes.push(n);
      return {
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            result: {
              number: `0x${n.toString(16)}`,
              timestamp: `0x${(GENESIS + n * options.secondsPerBlock).toString(16)}`,
            },
          }),
      };
    }
    if (method === "eth_getCode") {
      const n = Number.parseInt(params[1] as string, 16);
      codeProbes.push(n);
      const present =
        options.deployedAt !== null && n >= options.deployedAt ? CODE : "0x";
      return { ok: true, status: 200, json: () => Promise.resolve({ result: present }) };
    }
    throw new Error(`unexpected ${method}`);
  }) as unknown as typeof globalThis.fetch;

  return { fetch, codeProbes, blockProbes };
}

const origin = (stub: ReturnType<typeof chain>, horizonSeconds?: number) =>
  new RpcContractOrigin({
    url: "http://rpc.test",
    fetch: stub.fetch,
    ...(horizonSeconds === undefined ? {} : { horizonSeconds }),
  });

test("bisection recovers the exact block a contract was deployed in", async () => {
  const stub = chain({ head: 1_000_000, secondsPerBlock: 12, deployedAt: 990_123 });

  const result = await origin(stub).originOf(UNKNOWN as never);

  assert.equal(result.status, "deployed");
  assert.equal((result as { block: number }).block, 990_123);
  assert.equal(
    (result as { timestamp: number }).timestamp,
    GENESIS + 990_123 * 12,
  );
});

test("a contract already alive at the horizon costs one code read, not a bisection", async () => {
  const stub = chain({ head: 1_000_000, secondsPerBlock: 12, deployedAt: 1 });

  const result = await origin(stub).originOf(UNKNOWN as never);

  assert.equal(result.status, "older_than");
  // Head and horizon only: the search never pays for a precision the rule
  // does not use.
  assert.equal(stub.codeProbes.length, 2);
});

test("the horizon is verified against real timestamps, not assumed block times", async () => {
  // Two-second blocks: going back 7 days' worth of *assumed* 12s blocks lands
  // barely a day back, which would report a two-day-old contract as old.
  const stub = chain({ head: 4_000_000, secondsPerBlock: 2, deployedAt: 3_800_000 });

  const result = await origin(stub).originOf(UNKNOWN as never);

  assert.equal(result.status, "deployed");
  assert.equal((result as { block: number }).block, 3_800_000);
  const horizonProbe = stub.codeProbes[1]!;
  assert.ok(
    (4_000_000 - horizonProbe) * 2 >= 7 * 24 * 3600,
    `horizon block ${horizonProbe} was less than seven days behind head`,
  );
});

test("an address with no code at head yields indeterminate, never an age", async () => {
  const stub = chain({ head: 1_000_000, secondsPerBlock: 12, deployedAt: null });

  const result = await origin(stub).originOf(UNKNOWN as never);

  assert.equal(result.status, "indeterminate");
});

test("an RPC failure is indeterminate and carries the reason", async () => {
  const stub = chain({
    head: 1_000_000,
    secondsPerBlock: 12,
    deployedAt: 990_123,
    failMethod: "eth_getCode",
  });

  const result = await origin(stub).originOf(UNKNOWN as never);

  assert.equal(result.status, "indeterminate");
  assert.match((result as { reason: string }).reason, /503/);
});

test("a deployment block is searched for once and remembered", async () => {
  const stub = chain({ head: 1_000_000, secondsPerBlock: 12, deployedAt: 990_123 });
  const source = origin(stub);

  await source.originOf(UNKNOWN as never);
  const probes = stub.codeProbes.length;
  await source.originOf(UNKNOWN as never);

  assert.equal(stub.codeProbes.length, probes);
});

test("a fresh unindexed contract still refuses, which is where the argument holds", async () => {
  // The band that survived the fixture. Deployed within the window *and*
  // corroborated by nobody is not true of infrastructure, so it keeps its
  // teeth while the old band lost them.
  const outcome = await evaluate(
    rule([], { status: "deployed", block: 25_916_000, timestamp: secondsAgo(1800) }),
    context(transaction()),
  );

  assert.equal(outcome.findings![0]!.severity, "critical");
});
