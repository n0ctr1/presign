import assert from "node:assert/strict";
import { test } from "node:test";

import { VerdictEngine } from "../dist/index.js";
import type { Finding, Rule, UnsignedTransaction } from "../dist/index.js";

const T0 = new Date("2026-09-06T12:00:00Z");
const AGENT = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const TARGET = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

const tx = { from: AGENT, to: TARGET, value: 0n, data: "0x", chainId: 1 } as UnsignedTransaction;

function simulator(revertReason: string | null = null, chainId = 1) {
  return {
    chainId: () => Promise.resolve(chainId),
    // The engine takes a fork lease around every verdict; a double that does
    // not offer one would pass here and fail against the real simulator.
    withFreshFork: <T>(work: () => Promise<T>) => work(),
    simulate: () =>
      Promise.resolve({ pre: {}, post: {}, blockNumber: 25916120, revertReason }),
    asRuleReaders: () => ({
      getStorageAt: () => Promise.resolve("0x"),
      getCode: () => Promise.resolve("0x"),
      call: () => Promise.resolve(null),
    }),
  } as never;
}

const finding = (over: Partial<Finding> & Pick<Finding, "ruleId" | "severity">): Finding => ({
  title: "t",
  detail: "d",
  evidence: {},
  ...over,
}) as Finding;

const ruleFinding = (id: string, findings: readonly Finding[], sources?: unknown[]): Rule =>
  ({
    id,
    title: id,
    evaluate: () =>
      Promise.resolve({ status: "evaluated", findings, ...(sources ? { sources } : {}) }),
  }) as never;

const ruleUnavailable = (id: string, reason: string): Rule =>
  ({
    id,
    title: id,
    evaluate: () => Promise.resolve({ status: "unavailable", reason, detail: reason }),
  }) as never;

const engine = (rules: readonly Rule[], sim = simulator()) =>
  new VerdictEngine({ simulator: sim, rules, now: () => T0 });

test("clean rules yield low, and the action spells out what to do", async () => {
  const verdict = await engine([ruleFinding("R1", [])]).evaluate(tx);

  assert.equal(verdict.tier, "low");
  assert.match(verdict.action, /may sign/i);
});

test("a rule that cannot run turns an otherwise clean result into unavailable", async () => {
  const verdict = await engine([
    ruleFinding("R1", []),
    ruleUnavailable("R3", "all_candidates_stale"),
  ]).evaluate(tx);

  // The rules that ran say nothing about the rule that did not. Reporting
  // `low` here is the fail-open this project exists to prevent.
  assert.equal(verdict.tier, "unavailable");
  assert.match(verdict.action, /not the same as safe/i);
  // The detail travels with the reason: `all_candidates_stale` names the
  // class of failure, and only the sentence beside it says which deployments
  // were considered and how far behind they were.
  assert.deepEqual(verdict.provenance.unavailableRules, [
    {
      ruleId: "R3",
      reason: "all_candidates_stale",
      detail: "all_candidates_stale",
    },
  ]);
});

test("a definite finding outranks uncertainty", async () => {
  const verdict = await engine([
    ruleFinding("R1", [finding({ ruleId: "R1", severity: "critical", standing: false })]),
    ruleUnavailable("R3", "all_candidates_stale"),
  ]).evaluate(tx);

  // Something was proved wrong; the caller should hear that rather than
  // "could not evaluate". The uncertainty is still recorded.
  assert.equal(verdict.tier, "high");
  assert.equal(verdict.provenance.unavailableRules.length, 1);
});

test("a standing R2 critical is capped at medium", async () => {
  const verdict = await engine([
    ruleFinding("R2", [finding({ ruleId: "R2", severity: "critical", standing: true })]),
  ]).evaluate(tx);

  // True of every call to an ordinary proxy, USDC included. Letting it reach
  // `high` would refuse most real transactions and train callers to ignore
  // the verdict.
  assert.equal(verdict.tier, "medium");
  assert.match(verdict.action, /on-device/i);
});

test("an R2 finding about this transaction is not capped", async () => {
  const verdict = await engine([
    ruleFinding("R2", [finding({ ruleId: "R2", severity: "critical", standing: false })]),
  ]).evaluate(tx);

  // An implementation swap inside the call under judgement is not a standing
  // property, and must still reach high.
  assert.equal(verdict.tier, "high");
});

test("an R3 breach is not capped", async () => {
  const verdict = await engine([
    ruleFinding("R3", [finding({ ruleId: "R3", severity: "critical", standing: true })]),
  ]).evaluate(tx);

  assert.equal(verdict.tier, "high");
});

test("a warning yields medium", async () => {
  const verdict = await engine([
    ruleFinding("R1", [finding({ ruleId: "R1", severity: "warning", standing: false })]),
  ]).evaluate(tx);

  assert.equal(verdict.tier, "medium");
});

test("sources are reported even when nothing was found", async () => {
  const source = {
    deploymentId: "QmAave",
    displayName: "Aave V3 Ethereum",
    effectiveLagSeconds: 4,
    measuredAt: T0.toISOString(),
  };
  const verdict = await engine([ruleFinding("R3", [], [source])]).evaluate(tx);

  // "No problems" and "no problems according to a deployment 4s behind head"
  // are different claims. Only the second is checkable.
  assert.equal(verdict.tier, "low");
  assert.deepEqual(verdict.provenance.sources, [source]);
});

test("a throwing rule is unavailable, not silently clean", async () => {
  const exploding = {
    id: "R3",
    title: "R3",
    evaluate: () => Promise.reject(new Error("gateway exploded")),
  } as never as Rule;

  const verdict = await engine([ruleFinding("R1", []), exploding]).evaluate(tx);

  assert.equal(verdict.tier, "unavailable");
  assert.equal(verdict.provenance.unavailableRules[0]?.reason, "rule_error");
});

test("one rule throwing does not lose another rule's findings", async () => {
  const exploding = {
    id: "R3",
    title: "R3",
    evaluate: () => Promise.reject(new Error("boom")),
  } as never as Rule;

  const verdict = await engine([
    ruleFinding("R1", [finding({ ruleId: "R1", severity: "critical", standing: false })]),
    exploding,
  ]).evaluate(tx);

  assert.equal(verdict.tier, "high");
  assert.equal(verdict.findings.length, 1);
});

test("a reverting transaction is unavailable, not low", async () => {
  const verdict = await engine(
    [ruleFinding("R1", [])],
    simulator("execution reverted: insufficient balance"),
  ).evaluate(tx);

  // The rules that read what a transaction changes had nothing to read. That
  // is a transaction not evaluated, and a contract that reverts on the fork
  // but not on chain is how code hides from simulation.
  assert.equal(verdict.tier, "unavailable");
  assert.deepEqual(
    verdict.provenance.unavailableRules.map((r) => [r.ruleId, r.reason]),
    [["SIM", "reverts_in_simulation"]],
  );
  assert.equal(verdict.effects.observed, false);
});

test("a definite finding still outranks a revert", async () => {
  const verdict = await engine(
    [ruleFinding("R4", [finding({ ruleId: "R4", severity: "critical", standing: true })])],
    simulator("execution reverted"),
  ).evaluate(tx);

  assert.equal(verdict.tier, "high");
});

test("a transaction for another chain is unavailable, and nothing is simulated", async () => {
  let simulated = false;
  let ruleRan = false;
  const sim = {
    ...(simulator() as object),
    withFreshFork: () => {
      simulated = true;
      return Promise.reject(new Error("must not take a fork lease"));
    },
  } as never;
  const watching = {
    id: "R1",
    title: "R1",
    evaluate: () => {
      ruleRan = true;
      return Promise.resolve({ status: "evaluated", findings: [] });
    },
  } as never as Rule;

  // USDC on Base, sent to an engine whose fork holds Ethereum. Before the
  // guard this simulated against mainnet state and came back `low`.
  const verdict = await engine([watching], sim).evaluate({ ...tx, chainId: 8453 });

  assert.equal(verdict.tier, "unavailable");
  assert.equal(simulated, false);
  assert.equal(ruleRan, false);
  assert.equal(verdict.provenance.simulatedAtBlock, null);
  assert.equal(verdict.provenance.chainId, 8453);
  assert.deepEqual(
    verdict.provenance.unavailableRules.map((r) => [r.ruleId, r.reason]),
    [
      ["SIM", "unsupported_chain"],
      ["R1", "unsupported_chain"],
    ],
  );
  assert.match(verdict.provenance.unavailableRules[0]!.detail, /simulates chain 1/);
});

test("provenance states how old the simulated block and every list were", async () => {
  const sim = {
    ...(simulator() as object),
    simulate: () =>
      Promise.resolve({
        pre: {},
        post: {},
        blockNumber: 25916120,
        // Twenty-four seconds before the verdict.
        blockTimestamp: T0.getTime() / 1000 - 24,
        revertReason: null,
      }),
  } as never;
  const listed = {
    id: "R1",
    title: "R1",
    evaluate: () =>
      Promise.resolve({
        status: "evaluated",
        findings: [],
        lists: [
          {
            source: "ScamSniffer scam-database",
            url: "https://example.invalid/address.json",
            entries: 2530,
            fetchedAt: new Date(T0.getTime() - 3 * 3600 * 1000).toISOString(),
          },
        ],
      }),
  } as never as Rule;

  const verdict = await engine([listed], sim).evaluate(tx);

  // Indexed lag alone is half the staleness: the simulation and the blacklist
  // have ages too, and a reader cannot see the operator's refresh settings.
  assert.equal(verdict.provenance.simulatedBlockAgeSeconds, 24);
  assert.equal(verdict.provenance.lists.length, 1);
  assert.equal(verdict.provenance.lists[0]?.ageSeconds, 3 * 3600);
  assert.equal(verdict.provenance.lists[0]?.entries, 2530);
});

test("provenance records the simulated block and chain", async () => {
  const verdict = await engine([ruleFinding("R1", [])]).evaluate(tx);

  assert.equal(verdict.provenance.simulatedAtBlock, 25916120);
  assert.equal(verdict.provenance.chainId, 1);
  assert.equal(verdict.evaluatedAt, T0.toISOString());
});
