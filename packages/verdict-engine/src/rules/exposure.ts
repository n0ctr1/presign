/**
 * Whether a transaction leaves its sender more exposed to a contract than
 * before.
 *
 * R2's standing findings — "one key can replace this contract's code" — are
 * true of every call to the contract. What they threaten is whoever is exposed
 * to it *afterwards*: value it holds, allowances it can spend, claims it
 * records. A transfer of USDC out of an agent's wallet leaves the agent no more
 * exposed to USDC's admin than it already was, and escalating it to a human
 * would make every stablecoin payment wait for someone. A deposit into an
 * upgradeable vault with the same admin is the classic rug, and must not be
 * waved through by the same reasoning.
 *
 * So exposure is read from the state diff, the way R1 proves an allowance:
 * each claim below is a storage write matched to a mapping entry, not a guess
 * from calldata.
 */

import type { Address, Hex } from "viem";

import {
  mappingEntries,
  nestedMappingEntries,
  transactionAddresses,
} from "../simulation/mappings.js";
import type { StateDiff, UnsignedTransaction } from "../types.js";

/** Storage slots of `account` whose value rose in this transaction. */
function increasedSlots(diff: StateDiff, account: string): readonly string[] {
  const post = diff.post[account as Address]?.storage;
  if (post === undefined) return [];
  const pre = diff.pre[account as Address]?.storage;
  return Object.entries(post)
    .filter(([slot, value]) => BigInt(value) > BigInt(pre?.[slot as Hex] ?? "0x0"))
    .map(([slot]) => slot.toLowerCase());
}

export interface ExposureGrowth {
  readonly grows: boolean;
  /** Each way the transaction adds exposure, as a phrase a person can read. */
  readonly reasons: readonly string[];
}

export function exposureGrowth(
  transaction: UnsignedTransaction,
  diff: StateDiff,
  contract: Address,
): ExposureGrowth {
  // A reverted transaction changes nothing, so it exposes nobody to anything.
  if (diff.revertReason !== null) return { grows: false, reasons: [] };

  const target = contract.toLowerCase() as Address;
  const sender = transaction.from.toLowerCase() as Address;
  const reasons: string[] = [];

  const toTarget = transaction.to?.toLowerCase() === target;
  const preBalance = diff.pre[target]?.balance ?? 0n;
  const postBalance = diff.post[target]?.balance;
  if ((toTarget && transaction.value > 0n) || (postBalance !== undefined && postBalance > preBalance)) {
    reasons.push("sends it ETH");
  }

  // Tokens moving into the contract: some token's balance entry for it rose.
  const targetEntries = mappingEntries([target]);
  for (const account of Object.keys(diff.post)) {
    if (account.toLowerCase() === target) continue;
    if (increasedSlots(diff, account).some((slot) => targetEntries.has(slot))) {
      reasons.push(`moves tokens of ${account} into it`);
    }
  }

  const ownSlots = increasedSlots(diff, target);

  // An allowance on this contract, granted by the sender. A spender past the
  // candidate bound is missed here, and R1 reports that bound as unavailable.
  const allowances = nestedMappingEntries(sender, transactionAddresses(transaction, diff).addresses);
  if (ownSlots.some((slot) => allowances.has(slot))) reasons.push("grants an allowance on it");

  // A claim the contract records for the sender: shares, deposits, a balance.
  const senderEntries = mappingEntries([sender]);
  if (ownSlots.some((slot) => senderEntries.has(slot))) {
    reasons.push("increases a balance it records for the sender");
  }

  return { grows: reasons.length > 0, reasons };
}
