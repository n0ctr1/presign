import assert from "node:assert/strict";
import { test } from "node:test";

import { concat, keccak256, pad, toHex } from "viem";

import { calldataAddresses, valueEffects } from "../../dist/index.js";
import type { StateDiff, UnsignedTransaction } from "../../dist/index.js";

const SENDER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const ATTACKER = "0x2222222222222222222222222222222222222222";
const HIDDEN = "0x3333333333333333333333333333333333333333";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

const balanceSlot = (holder: string, p = 9) =>
  keccak256(concat([pad(holder as `0x${string}`, { size: 32 }), pad(toHex(p), { size: 32 })]));
const word = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;
const arg = (address: string) => address.slice(2).padStart(64, "0");

const tx = (over: Partial<UnsignedTransaction> = {}) =>
  ({ from: SENDER, to: USDC, value: 0n, data: "0x", chainId: 1, ...over }) as UnsignedTransaction;
const diff = (pre: object, post: object, revertReason: string | null = null) =>
  ({ pre, post, blockNumber: 1, revertReason }) as unknown as StateDiff;

test("ETH sent to an address is value out, and the address is named", () => {
  const effects = valueEffects(
    tx({ to: ATTACKER as never, value: 6n }),
    diff({ [SENDER]: { balance: 10n }, [ATTACKER]: { balance: 0n } }, { [SENDER]: { balance: 4n }, [ATTACKER]: { balance: 6n } }),
  );

  // No rule fires on this: it is the plainest way to lose money, and exactly
  // what a compromised agent would ask a signer for.
  assert.equal(effects.observed, true);
  assert.equal(effects.ethOutWei, "6");
  assert.deepEqual(effects.ethRecipients, [ATTACKER]);
});

test("a token transfer names the token, the amount and who received it", () => {
  const effects = valueEffects(
    tx({ data: `0xa9059cbb${arg(ATTACKER)}${word(100n).slice(2)}` as never }),
    diff(
      { [USDC]: { storage: { [balanceSlot(SENDER)]: word(500n), [balanceSlot(ATTACKER)]: word(0n) } } },
      { [USDC]: { storage: { [balanceSlot(SENDER)]: word(400n), [balanceSlot(ATTACKER)]: word(100n) } } },
    ),
  );

  assert.deepEqual(effects.tokensOut, [
    { token: USDC, amountOut: "100", recipients: [ATTACKER], burned: false, unidentifiedRecipient: false },
  ]);
});

test("value that lands with nobody the analysis can name is flagged, not dropped", () => {
  const effects = valueEffects(
    tx({ data: "0x12345678" as never }),
    diff(
      { [USDC]: { storage: { [balanceSlot(SENDER)]: word(500n) } } },
      { [USDC]: { storage: { [balanceSlot(SENDER)]: word(0n), [balanceSlot(HIDDEN)]: word(500n) } } },
    ),
  );

  assert.equal(effects.tokensOut[0]?.unidentifiedRecipient, true);
  assert.deepEqual(effects.tokensOut[0]?.recipients, []);
});

test("a hidden recipient beside a named one is still reported", () => {
  // One unit to an address the calldata names, the rest to one it does not.
  // A signer allowlisting the named address must not be told that is all.
  const effects = valueEffects(
    tx({ data: `0xa9059cbb${arg(ATTACKER)}${word(1n).slice(2)}` as never }),
    diff(
      { [USDC]: { storage: { [balanceSlot(SENDER)]: word(500n) } } },
      { [USDC]: { storage: { [balanceSlot(SENDER)]: word(0n), [balanceSlot(ATTACKER)]: word(1n), [balanceSlot(HIDDEN)]: word(499n) } } },
    ),
  );

  assert.deepEqual(effects.tokensOut[0]?.recipients, [ATTACKER]);
  assert.equal(effects.tokensOut[0]?.unidentifiedRecipient, true);
});

test("tokens that leave and land nowhere are burned", () => {
  const effects = valueEffects(
    tx(),
    diff({ [USDC]: { storage: { [balanceSlot(SENDER)]: word(500n) } } }, { [USDC]: { storage: { [balanceSlot(SENDER)]: word(0n) } } }),
  );

  assert.equal(effects.tokensOut[0]?.burned, true);
  assert.equal(effects.tokensOut[0]?.unidentifiedRecipient, false);
});

test("addresses nested four bytes off the word boundary are found", () => {
  // execute(USDC, 0, approve(attacker, max)): the inner arguments sit after a
  // selector, so an aligned scan returns the offsets and misses the attacker.
  const inner = `095ea7b3${arg(ATTACKER)}${"f".repeat(64)}`;
  const data = `0xb61d27f6${arg(USDC)}${"0".repeat(64)}${arg("0x60")}${arg("0x44")}${inner}${"0".repeat(56)}`;

  assert.ok(calldataAddresses(data as never).includes(ATTACKER as never));
});

test("a reverted transaction reports that nothing was observed", () => {
  const effects = valueEffects(tx({ value: 1n }), diff({}, {}, "execution reverted"));
  assert.equal(effects.observed, false);
});
