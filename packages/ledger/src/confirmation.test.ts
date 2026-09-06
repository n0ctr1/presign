import assert from "node:assert/strict";
import { test } from "node:test";

import { DeviceConfirmation } from "../dist/index.js";
import type { SignableTransaction, TransactionSigner } from "../dist/index.js";
import type { Verdict } from "@presign/verdict-engine";

const AGENT = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

const transaction = {
  from: AGENT,
  to: USDC,
  value: 0n,
  data: "0x",
  chainId: 1,
  nonce: 7,
  gasLimit: 100_000n,
  maxFeePerGas: 30_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
} as SignableTransaction;

const verdict = (tier: string) =>
  ({
    tier,
    action: "",
    findings: [{ ruleId: "R2", severity: "critical", title: "Upgradeable" }],
    provenance: { simulatedAtBlock: 1, chainId: 1, sources: [], unavailableRules: [] },
    evaluatedAt: "2026-09-06T12:00:00Z",
  }) as unknown as Verdict;

const SIGNATURE = { r: "0x11", s: "0x22", v: 27 };

/** Emits a scripted sequence of device-action states. */
function scriptedSigner(states: readonly Record<string, unknown>[]): TransactionSigner {
  return {
    signTransaction: () => ({
      observable: {
        subscribe(handlers: {
          next: (state: Record<string, unknown>) => void;
          error: (error: unknown) => void;
        }) {
          queueMicrotask(() => {
            for (const state of states) handlers.next(state);
          });
          return { unsubscribe() {} };
        },
      },
      cancel() {},
    }),
  };
}

const confirmation = (signer: TransactionSigner, timeoutMs?: number) =>
  new DeviceConfirmation({
    device: { kit: {}, sessionId: "s" } as never,
    signerFactory: () => signer,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });

const pending = (step: string) => ({
  status: "pending",
  intermediateValue: { step, requiredUserInteraction: "sign-transaction" },
});

test("refuses to present a high-risk transaction to the device", async () => {
  let called = false;
  const signer = {
    signTransaction: () => {
      called = true;
      throw new Error("must not be reached");
    },
  } as unknown as TransactionSigner;

  const result = await confirmation(signer).request(transaction, verdict("high"));

  assert.equal(result.approved, false);
  assert.ok(!result.approved);
  assert.equal(result.reason, "not_escalated");
  // The policy is re-checked at the boundary: a caller passing a high verdict
  // by mistake must not be able to turn a refusal into a prompt.
  assert.equal(called, false);
});

test("refuses an unavailable verdict for the same reason", async () => {
  const result = await confirmation(scriptedSigner([])).request(
    transaction,
    verdict("unavailable"),
  );

  assert.ok(!result.approved);
  assert.equal(result.reason, "not_escalated");
});

test("returns the signature when the human approves", async () => {
  const result = await confirmation(
    scriptedSigner([
      pending("signer.eth.steps.parseTransaction"),
      pending("signer.eth.steps.signTransaction"),
      { status: "completed", output: SIGNATURE },
    ]),
  ).request(transaction, verdict("medium"));

  assert.ok(result.approved);
  assert.deepEqual(result.signature, SIGNATURE);
  assert.equal(result.clearSigned, true);
});

test("reports a blind-signing fallback rather than tolerating it", async () => {
  const result = await confirmation(
    scriptedSigner([
      pending("signer.eth.steps.detectBlindSigning"),
      pending("signer.eth.steps.blindSignTransactionFallback"),
      { status: "completed", output: SIGNATURE },
    ]),
  ).request(transaction, verdict("medium"));

  assert.ok(result.approved);
  // The human approved a hash, not a decoded transaction. The confirmation
  // carries far less meaning than it appears to, so the caller is told.
  assert.equal(result.clearSigned, false);
});

test("a decline on the device is not an error", async () => {
  const result = await confirmation(
    scriptedSigner([pending("signer.eth.steps.signTransaction"), { status: "stopped" }]),
  ).request(transaction, verdict("medium"));

  assert.ok(!result.approved);
  assert.equal(result.reason, "rejected_on_device");
});

test("an app rejection status word is read as a decline, not a fault", async () => {
  const result = await confirmation(
    scriptedSigner([{ status: "error", error: { message: "Ledger error: 0x6985" } }]),
  ).request(transaction, verdict("medium"));

  assert.ok(!result.approved);
  // 0x6985 is "conditions of use not satisfied" — the user pressed reject.
  // Calling that a device fault would hide a deliberate human decision.
  assert.equal(result.reason, "rejected_on_device");
});

test("a genuine device fault is distinguished from a decline", async () => {
  const result = await confirmation(
    scriptedSigner([{ status: "error", error: { message: "device disconnected" } }]),
  ).request(transaction, verdict("medium"));

  assert.ok(!result.approved);
  assert.equal(result.reason, "device_error");
});

test("gives up if the human never answers", async () => {
  const result = await confirmation(
    scriptedSigner([pending("signer.eth.steps.signTransaction")]),
    50,
  ).request(transaction, verdict("medium"));

  assert.ok(!result.approved);
  assert.equal(result.reason, "timeout");
});
