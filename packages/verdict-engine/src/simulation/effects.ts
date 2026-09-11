/**
 * What a transaction moves out of the sender's wallet, read from the diff.
 *
 * The rules look for known risks — an unlimited approval, replaceable code, a
 * protocol whose books do not balance, a contract nobody knows. None of them
 * is about the plainest way to lose money: sending it. A transfer of the whole
 * balance to an attacker trips no rule and comes back `low`, which is correct
 * for an advisor asked "is this counterparty dangerous" and wrong for anything
 * that signs. So the engine reports the outflow as a fact alongside the tier,
 * and whoever holds the key applies a policy to it.
 *
 * Every figure is proven from storage the transaction wrote, the way R1 proves
 * an allowance: a token balance is a `mapping(address => uint256)` entry, and
 * its slot is recomputed for each candidate holder.
 */

import type { Address, Hex } from "viem";

import type { StateDiff, UnsignedTransaction, ValueEffects } from "../types.js";
import { mappingEntries, transactionAddresses, type MappingEntry } from "./mappings.js";

/** Reported for a transaction whose effects could not be read. */
export const NO_EFFECTS: ValueEffects = {
  observed: false,
  ethOutWei: "0",
  ethRecipients: [],
  tokensOut: [],
};

export function valueEffects(transaction: UnsignedTransaction, diff: StateDiff): ValueEffects {
  // A reverted transaction moves nothing, but it was also not evaluated; the
  // engine reports it as unavailable, and the effects say they were not read.
  if (diff.revertReason !== null) return NO_EFFECTS;

  const sender = transaction.from.toLowerCase() as Address;

  // ETH. The simulation charges no gas, so a falling balance is value sent.
  const preEth = diff.pre[sender]?.balance;
  const postEth = diff.post[sender]?.balance;
  const ethOut = preEth !== undefined && postEth !== undefined && preEth > postEth ? preEth - postEth : 0n;
  const ethRecipients = Object.keys(diff.post)
    .map((account) => account.toLowerCase() as Address)
    .filter((account) => {
      if (account === sender) return false;
      const after = diff.post[account]?.balance;
      return after !== undefined && after > (diff.pre[account]?.balance ?? 0n);
    });

  const senderEntries = mappingEntries([sender]);
  // Hashed only once a token actually leaves the sender. A candidate dropped
  // by the bound is not lost silently: its balance entry stays unexplained,
  // and an unexplained rise is reported as an unidentified recipient.
  let holders: ReadonlyMap<string, MappingEntry> | null = null;

  const tokensOut: ValueEffects["tokensOut"][number][] = [];
  for (const [rawToken, account] of Object.entries(diff.post)) {
    const token = rawToken.toLowerCase() as Address;
    const storage = account.storage;
    if (storage === undefined) continue;
    const before = diff.pre[rawToken as Address]?.storage;

    let amountOut = 0n;
    const increased: string[] = [];
    for (const [rawSlot, rawValue] of Object.entries(storage)) {
      const slot = rawSlot.toLowerCase();
      const after = BigInt(rawValue);
      const prior = BigInt(before?.[rawSlot as Hex] ?? "0x0");
      if (after < prior) {
        if (senderEntries.has(slot)) amountOut += prior - after;
      } else if (after > prior) {
        increased.push(slot);
      }
    }
    if (amountOut === 0n) continue;

    holders ??= mappingEntries(
      transactionAddresses(transaction, diff).addresses.filter((candidate) => candidate !== sender),
    );
    const named = increased.map((slot) => holders!.get(slot)?.key);
    const recipients = [...new Set(named.filter((holder): holder is Address => holder !== undefined))];
    tokensOut.push({
      token,
      amountOut: amountOut.toString(),
      recipients,
      // Nothing rose at all: the tokens were burned, not handed to anyone.
      burned: increased.length === 0,
      // Something rose that no candidate address explains. A named recipient
      // beside it does not settle where the rest went: paying an allowlisted
      // address one unit must not vouch for a second, hidden transfer.
      unidentifiedRecipient: named.some((holder) => holder === undefined),
    });
  }

  return {
    observed: true,
    ethOutWei: ethOut.toString(),
    ethRecipients,
    tokensOut,
  };
}
