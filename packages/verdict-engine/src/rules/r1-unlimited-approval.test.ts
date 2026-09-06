import assert from "node:assert/strict";
import { test } from "node:test";

import {
  addressCandidates,
  allowanceSlot,
  UnlimitedApprovalRule,
} from "../../dist/index.js";
import type { StateDiff, UnsignedTransaction } from "../../dist/index.js";

const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const OWNER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const SPENDER = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
const MAX = `0x${"f".repeat(64)}`;

/** USDC's allowance mapping position, recovered by search against mainnet. */
const USDC_ALLOWANCE_MAPPING_SLOT = 10;

const approveCalldata = (spender: string, amountHex: string) =>
  `0x095ea7b3${spender.slice(2).padStart(64, "0")}${amountHex}`;

function transaction(overrides: Partial<UnsignedTransaction> = {}) {
  return {
    from: OWNER,
    to: USDC,
    value: 0n,
    data: approveCalldata(SPENDER, "f".repeat(64)),
    chainId: 1,
    ...overrides,
  } as UnsignedTransaction;
}

function diffWriting(slot: string, value: string, token = USDC): StateDiff {
  return {
    pre: {},
    post: { [token]: { storage: { [slot]: value } } },
    blockNumber: 25916120,
    revertReason: null,
  } as unknown as StateDiff;
}

const context = (tx: UnsignedTransaction, diff: StateDiff) =>
  ({
    transaction: tx,
    diff,
    getStorageAt: () => Promise.reject(new Error("unused")),
    getCode: () => Promise.reject(new Error("unused")),
  }) as never;

test("reproduces USDC's real allowance slot from the mapping layout", () => {
  // Confirmed on mainnet: this is the slot the tracer reported for this pair.
  assert.equal(
    allowanceSlot(OWNER, SPENDER, USDC_ALLOWANCE_MAPPING_SLOT).toLowerCase(),
    "0x9364ceadd85b1a5e37140ae24b0208a2ddc63c5e08ed1e4feae224ac4edf5e8e",
  );
});

test("pulls address-shaped words out of calldata and skips the rest", () => {
  const data = approveCalldata(SPENDER, "f".repeat(64));

  // The amount word is all-ff, so it is not address-shaped and must not be
  // mistaken for a spender.
  assert.deepEqual(addressCandidates(data as never), [SPENDER]);
});

test("proves an unlimited approval from the diff, naming the mapping slot", async () => {
  const slot = allowanceSlot(OWNER, SPENDER, USDC_ALLOWANCE_MAPPING_SLOT);
  const findings = await new UnlimitedApprovalRule().evaluate(
    context(transaction(), diffWriting(slot, MAX)),
  );

  assert.equal(findings.length, 1);
  const [finding] = findings;
  assert.equal(finding?.ruleId, "R1");
  assert.equal(finding?.evidence["spender"], SPENDER);
  assert.equal(finding?.evidence["mapping_slot"], USDC_ALLOWANCE_MAPPING_SLOT);
  assert.equal(finding?.evidence["is_exact_max"], true);
  // The claim rests on the observed write, not on the calldata.
  assert.equal(finding?.evidence["derived_from"], "state_diff");
});

test("catches an approval the calldata does not mention", async () => {
  const slot = allowanceSlot(OWNER, SPENDER, USDC_ALLOWANCE_MAPPING_SLOT);

  // A router call whose calldata names the spender nowhere. Decoding
  // `approve` would find nothing here; the write is unmistakable.
  const tx = transaction({ to: SPENDER, data: "0xdeadbeef" });
  const findings = await new UnlimitedApprovalRule().evaluate(
    context(tx, diffWriting(slot, MAX)),
  );

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.evidence["spender"], SPENDER);
});

test("ignores a bounded approval", async () => {
  const slot = allowanceSlot(OWNER, SPENDER, USDC_ALLOWANCE_MAPPING_SLOT);
  const thousandUsdc = `0x${(1000n * 10n ** 6n).toString(16).padStart(64, "0")}`;

  assert.deepEqual(
    await new UnlimitedApprovalRule().evaluate(
      context(transaction(), diffWriting(slot, thousandUsdc)),
    ),
    [],
  );
});

test("ignores a large write that is not an allowance slot", async () => {
  // Same value, unrelated slot: without the mapping proof this would be a
  // false positive, and a scanner that flags healthy contracts is worse than
  // one with narrow coverage.
  assert.deepEqual(
    await new UnlimitedApprovalRule().evaluate(
      context(transaction(), diffWriting(`0x${"ab".repeat(32)}`, MAX)),
    ),
    [],
  );
});

test("reports nothing when the transaction reverts", async () => {
  const slot = allowanceSlot(OWNER, SPENDER, USDC_ALLOWANCE_MAPPING_SLOT);
  const diff = { ...diffWriting(slot, MAX), revertReason: "execution reverted" };

  // An approval that never lands must not be reported, or callers learn to
  // ignore the rule.
  assert.deepEqual(
    await new UnlimitedApprovalRule().evaluate(context(transaction(), diff)),
    [],
  );
});

test("honours an allowlisted spender", async () => {
  const slot = allowanceSlot(OWNER, SPENDER, USDC_ALLOWANCE_MAPPING_SLOT);
  const rule = new UnlimitedApprovalRule({ allowlist: [SPENDER as never] });

  assert.deepEqual(
    await rule.evaluate(context(transaction(), diffWriting(slot, MAX))),
    [],
  );
});

test("escalates to critical for a spender in the incident registry", async () => {
  const slot = allowanceSlot(OWNER, SPENDER, USDC_ALLOWANCE_MAPPING_SLOT);
  const rule = new UnlimitedApprovalRule({ incidentRegistry: [SPENDER as never] });

  const findings = await rule.evaluate(
    context(transaction(), diffWriting(slot, MAX)),
  );

  assert.equal(findings[0]?.severity, "critical");
  assert.match(String(findings[0]?.title), /known incident/i);
});

test("flags a very large approval that is not exactly max", async () => {
  const slot = allowanceSlot(OWNER, SPENDER, USDC_ALLOWANCE_MAPPING_SLOT);
  const huge = `0x${(2n ** 200n).toString(16).padStart(64, "0")}`;

  const findings = await new UnlimitedApprovalRule().evaluate(
    context(transaction(), diffWriting(slot, huge)),
  );

  // Matching only type(uint256).max would miss the common evasion of
  // approving an astronomically large but non-maximal amount.
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.evidence["is_exact_max"], false);
});
