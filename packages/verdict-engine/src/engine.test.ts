import assert from "node:assert/strict";
import { test } from "node:test";

import { VerdictEngine } from "../dist/index.js";
import type { Finding, Rule, UnsignedTransaction } from "../dist/index.js";

const T0 = new Date("2026-09-06T12:00:00Z");
const AGENT = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const TARGET = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

const tx = { from: AGENT, to: TARGET, value: 0n, data: "0x", chainId: 1 } as UnsignedTransaction;

function simulator(revertReason: string | null = null) {
  return {
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

test("a reverting transaction is reported as an observation", async () => {
  const verdict = await engine(
    [ruleFinding("R1", [])],
    simulator("execution reverted: insufficient balance"),
  ).evaluate(tx);

  const revert = verdict.findings.find((f) => f.ruleId === "SIM");
  assert.ok(revert);
  // It changes nothing on success paths, so it does not raise the tier.
  assert.equal(verdict.tier, "low");
});

test("provenance records the simulated block and chain", async () => {
  const verdict = await engine([ruleFinding("R1", [])]).evaluate(tx);

  assert.equal(verdict.provenance.simulatedAtBlock, 25916120);
  assert.equal(verdict.provenance.chainId, 1);
  assert.equal(verdict.evaluatedAt, T0.toISOString());
});
