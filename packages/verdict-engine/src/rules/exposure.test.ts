import assert from "node:assert/strict";
import { test } from "node:test";

import { concat, keccak256, pad, toHex } from "viem";

import { allowanceSlot, exposureGrowth } from "../../dist/index.js";
import type { StateDiff, UnsignedTransaction } from "../../dist/index.js";

const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const VAULT = "0x1111111111111111111111111111111111111111";
const AGENT = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const FRIEND = "0x2222222222222222222222222222222222222222";
const PERMIT2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";

/** USDC keeps balances at slot 9 and allowances at slot 10. */
const balanceSlot = (holder: string, p = 9) =>
  keccak256(concat([pad(holder as `0x${string}`, { size: 32 }), pad(toHex(p), { size: 32 })]));
const word = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;

const tx = (over: Partial<UnsignedTransaction> = {}) =>
  ({ from: AGENT, to: USDC, value: 0n, data: "0x", chainId: 1, ...over }) as UnsignedTransaction;

const diff = (pre: object, post: object, revertReason: string | null = null) =>
  ({ pre, post, blockNumber: 1, revertReason }) as unknown as StateDiff;

test("a USDC transfer out of the wallet adds no exposure to USDC", () => {
  // The sender's balance falls and a friend's rises: nothing new is held by,
  // or claimable from, USDC on the sender's behalf.
  const d = diff(
    { [USDC]: { storage: { [balanceSlot(AGENT)]: word(500n), [balanceSlot(FRIEND)]: word(0n) } } },
    { [USDC]: { storage: { [balanceSlot(AGENT)]: word(400n), [balanceSlot(FRIEND)]: word(100n) } } },
  );

  assert.deepEqual(exposureGrowth(tx(), d, USDC), { grows: false, reasons: [] });
});

test("an approval on the token is exposure to it", () => {
  const slot = allowanceSlot(AGENT, PERMIT2, 10);
  const d = diff({}, { [USDC]: { storage: { [slot]: word(1000n * 10n ** 6n) } } });

  const growth = exposureGrowth(
    tx({ data: `0x095ea7b3${PERMIT2.slice(2).padStart(64, "0")}${"0".repeat(64)}` as never }),
    d,
    USDC,
  );

  assert.equal(growth.grows, true);
  assert.deepEqual(growth.reasons, ["grants an allowance on it"]);
});

test("a deposit pulled by transferFrom is exposure, with no approval and no ETH in sight", () => {
  // The rug this rule exists for: tokens leave the agent for an upgradeable
  // vault under an allowance granted long ago, and the vault records shares.
  const d = diff(
    {
      [USDC]: { storage: { [balanceSlot(AGENT)]: word(500n), [balanceSlot(VAULT)]: word(0n) } },
      [VAULT]: { storage: { [balanceSlot(AGENT, 3)]: word(0n) } },
    },
    {
      [USDC]: { storage: { [balanceSlot(AGENT)]: word(0n), [balanceSlot(VAULT)]: word(500n) } },
      [VAULT]: { storage: { [balanceSlot(AGENT, 3)]: word(500n) } },
    },
  );

  const growth = exposureGrowth(tx({ to: VAULT as never }), d, VAULT);

  assert.equal(growth.grows, true);
  assert.ok(growth.reasons.some((r) => /moves tokens/.test(r)));
  assert.ok(growth.reasons.includes("increases a balance it records for the sender"));
});

test("ETH sent to the contract is exposure", () => {
  const growth = exposureGrowth(tx({ to: VAULT as never, value: 1n }), diff({}, {}), VAULT);
  assert.deepEqual(growth.reasons, ["sends it ETH"]);
});

test("a reverted transaction exposes nobody", () => {
  const growth = exposureGrowth(tx({ to: VAULT as never, value: 1n }), diff({}, {}, "reverted"), VAULT);
  assert.equal(growth.grows, false);
});
