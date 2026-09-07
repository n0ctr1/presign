import assert from "node:assert/strict";
import { test } from "node:test";

import { PresignPipeline, describe as describeOutcome } from "../dist/index.js";
import type { ConfirmationRequester } from "../dist/index.js";
import type { UnsignedTransaction, Verdict } from "@presign/verdict-engine";

const tx = {
  from: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  to: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  value: 0n,
  data: "0x",
  chainId: 1,
} as UnsignedTransaction;

const SIGNATURE = { r: "0x11", s: "0x22", v: 27 };

function engineReturning(tier: string) {
  return {
    evaluate: () =>
      Promise.resolve({
        tier,
        action: "",
        findings: [],
        provenance: {
          simulatedAtBlock: 1,
          chainId: 1,
          sources: [],
          unavailableRules: tier === "unavailable" ? [{ ruleId: "R3", reason: "x" }] : [],
        },
        evaluatedAt: "2026-09-07T12:00:00Z",
      } as unknown as Verdict),
  } as never;
}

const approving = (clearSigned = true): ConfirmationRequester => ({
  request: () => Promise.resolve({ approved: true, signature: SIGNATURE, clearSigned }),
});

const refusing = (reason: string, detail = "d"): ConfirmationRequester => ({
  request: () => Promise.resolve({ approved: false, reason, detail }),
});

const pipeline = (tier: string, confirmation?: ConfirmationRequester) =>
  new PresignPipeline({
    engine: engineReturning(tier),
    ...(confirmation === undefined ? {} : { confirmation }),
  });

test("a low verdict says the agent may sign, and returns no signature", async () => {
  const outcome = await pipeline("low", approving()).run(tx);

  // The agent's key is not ours to use. A service that could sign would be a
  // custodian, not an advisor.
  assert.equal(outcome.decision, "may_sign");
  assert.ok(!("signature" in outcome));
});

test("a high verdict is refused without touching the device", async () => {
  let asked = false;
  const confirmation: ConfirmationRequester = {
    request: () => {
      asked = true;
      throw new Error("must not be reached");
    },
  };

  const outcome = await pipeline("high", confirmation).run(tx);

  assert.equal(outcome.decision, "refused");
  assert.equal(asked, false);
});

test("an unavailable verdict is refused for the same reason", async () => {
  let asked = false;
  const outcome = await pipeline("unavailable", {
    request: () => {
      asked = true;
      throw new Error("must not be reached");
    },
  }).run(tx);

  assert.equal(outcome.decision, "refused");
  assert.equal(asked, false);
  assert.match(
    outcome.decision === "refused" ? outcome.rationale : "",
    /not the same as safe/i,
  );
});

test("a medium verdict with no device configured asks for escalation", async () => {
  const outcome = await pipeline("medium").run(tx);

  // Not a degraded allow. The caller is told a human must look, and how is
  // their business.
  assert.equal(outcome.decision, "escalation_required");
});

test("a medium verdict confirmed on the device returns the signature", async () => {
  const outcome = await pipeline("medium", approving()).run(tx);

  assert.equal(outcome.decision, "signed_after_confirmation");
  assert.ok(outcome.decision === "signed_after_confirmation");
  assert.deepEqual(outcome.signature, SIGNATURE);
  assert.equal(outcome.clearSigned, true);
});

test("a blind-signed confirmation is carried through, not hidden", async () => {
  const outcome = await pipeline("medium", approving(false)).run(tx);

  assert.ok(outcome.decision === "signed_after_confirmation");
  assert.equal(outcome.clearSigned, false);
  assert.match(describeOutcome(outcome), /BLIND SIGNED/);
});

test("a human decline is reported as a human decision", async () => {
  const outcome = await pipeline("medium", refusing("rejected_on_device")).run(tx);

  assert.equal(outcome.decision, "declined_by_human");
});

test("a device fault is not reported as a human decision", async () => {
  const outcome = await pipeline("medium", refusing("device_error", "boom")).run(tx);

  // Nobody was asked. Calling this a refusal would invent a decision that
  // never happened — the same mistake that once masked a transport fault.
  assert.equal(outcome.decision, "escalation_failed");
  assert.ok(outcome.decision === "escalation_failed");
  assert.equal(outcome.reason, "device_error");
});

test("a timeout is a failure to ask, not a refusal", async () => {
  const outcome = await pipeline("medium", refusing("timeout")).run(tx);

  assert.equal(outcome.decision, "escalation_failed");
});

test("the signable transaction is what reaches the device", async () => {
  let received: unknown;
  const confirmation: ConfirmationRequester = {
    request: (transaction) => {
      received = transaction;
      return Promise.resolve({ approved: true, signature: SIGNATURE, clearSigned: true });
    },
  };
  const signable = { ...tx, nonce: 7, gasLimit: 21000n };

  await pipeline("medium", confirmation).run(tx, signable);

  // The assessment shape and the signable shape are different objects; a fee
  // chosen after the verdict must not be mistaken for one it covered.
  assert.deepEqual(received, signable);
});
