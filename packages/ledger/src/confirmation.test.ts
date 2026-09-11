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

test("reads the device address without asking the human to confirm it", async () => {
  let asked: { checkOnDevice?: boolean } | undefined;
  const signer = {
    ...scriptedSigner([]),
    getAddress: (_path: string, options?: { checkOnDevice?: boolean }) => {
      asked = options;
      return {
        observable: {
          subscribe(handlers: { next: (state: Record<string, unknown>) => void }) {
            queueMicrotask(() =>
              handlers.next({ status: "completed", output: { address: AGENT, publicKey: "0x04" } }),
            );
            return { unsubscribe() {} };
          },
        },
        cancel() {},
      };
    },
  } as unknown as TransactionSigner;

  // A broker checking that a device signature came from this device needs the
  // address; a prompt to confirm an address nobody chose decides nothing.
  assert.equal(await confirmation(signer).address(), AGENT);
  assert.equal(asked?.checkOnDevice, false);
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

test("the blind-signing *check* is not mistaken for the fallback", async () => {
  // Exact step sequence recorded from a Nano X signing an ERC-20 approval.
  // detectBlindSigning runs on every signature, so a substring match on
  // "blind" reported every transaction as blind-signed — including this one,
  // which the device decoded. Caught only by running against hardware.
  const result = await confirmation(
    scriptedSigner([
      pending("signer.eth.steps.openApp"),
      pending("signer.eth.steps.getAppConfig"),
      pending("signer.eth.steps.parseTransaction"),
      pending("signer.eth.steps.getAddress"),
      pending("signer.eth.steps.buildContexts"),
      pending("signer.eth.steps.provideContexts"),
      pending("signer.eth.steps.signTransaction"),
      pending("signer.eth.steps.detectBlindSigning"),
      { status: "completed", output: SIGNATURE },
    ]),
  ).request(transaction, verdict("medium"));

  assert.ok(result.approved);
  assert.equal(result.clearSigned, true);
});

test("clear signing is claimed on evidence, not on the absence of a fallback", async () => {
  // No intermediate states at all: nothing shows the device decoded anything.
  const silent = await confirmation(
    scriptedSigner([{ status: "completed", output: SIGNATURE }]),
  ).request(transaction, verdict("medium"));
  assert.ok(silent.approved);
  assert.equal(silent.clearSigned, false);

  // A fallback step under a name a future signer release might use.
  const renamed = await confirmation(
    scriptedSigner([
      pending("signer.eth.steps.signTransaction"),
      pending("signer.eth.steps.blindSigningFallback"),
      { status: "completed", output: SIGNATURE },
    ]),
  ).request(transaction, verdict("medium"));
  assert.ok(renamed.approved);
  assert.equal(renamed.clearSigned, false);
});

test("a stopped action is not reported as a human decision", async () => {
  const result = await confirmation(
    scriptedSigner([pending("signer.eth.steps.signTransaction"), { status: "stopped" }]),
  ).request(transaction, verdict("medium"));

  assert.ok(!result.approved);
  // Stopped means the action halted, which is not someone pressing reject.
  // Reporting it as a decline invents a human decision that never happened —
  // and that is exactly what masked a real transport fault during the first
  // live run against hardware.
  assert.equal(result.reason, "cancelled");
});

test("a decline is read from errorCode, not from the message text", async () => {
  // Recorded verbatim from a Nano X after pressing reject. The message says
  // "Condition not satisfied" and contains none of the words one would search
  // for, so matching on prose lost the person's decision and reported a fault.
  const result = await confirmation(
    scriptedSigner([
      {
        status: "error",
        error: {
          _tag: "EthAppCommandError",
          errorCode: "6985",
          message: "Condition not satisfied",
        },
      },
    ]),
  ).request(transaction, verdict("medium"));

  assert.ok(!result.approved);
  assert.equal(result.reason, "rejected_on_device");
  assert.match(result.detail, /declined on the device/);
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
