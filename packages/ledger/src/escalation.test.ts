import assert from "node:assert/strict";
import { test } from "node:test";

import { decideEscalation } from "../dist/index.js";
import type { Verdict } from "@presign/verdict-engine";

const verdict = (tier: string, findings: unknown[] = []) =>
  ({
    tier,
    action: "",
    findings,
    provenance: { simulatedAtBlock: 1, chainId: 1, sources: [], unavailableRules: [] },
    evaluatedAt: "2026-09-06T12:00:00Z",
  }) as unknown as Verdict;

test("a clean verdict needs no device", () => {
  assert.equal(decideEscalation(verdict("low")).action, "sign_directly");
});

test("a medium verdict goes to the device with a readable summary", () => {
  const decision = decideEscalation(
    verdict("medium", [
      { ruleId: "R2", severity: "critical", title: "Upgradeable contract controlled by a single key" },
      { ruleId: "R2", severity: "info", title: "Some background detail" },
    ]),
  );

  assert.equal(decision.action, "confirm_on_device");
  assert.ok(decision.action === "confirm_on_device");
  // Info-level noise is dropped: a device screen has room for what matters.
  assert.deepEqual(decision.summary, [
    "R2: Upgradeable contract controlled by a single key",
  ]);
});

test("a high verdict is refused and never reaches the device", () => {
  const decision = decideEscalation(verdict("high"));

  // Showing a human a transaction already known to be dangerous invites
  // approval. Refusal has to be refusal, not a prompt with a scary title.
  assert.equal(decision.action, "refuse");
  assert.match(decision.rationale, /invite approval/i);
});

test("an unavailable verdict is refused, not delegated to a human", () => {
  const decision = decideEscalation(verdict("unavailable"));

  // The human has strictly less information than the service that gave up.
  assert.equal(decision.action, "refuse");
  assert.match(decision.rationale, /less information/i);
});
