/**
 * Proving what a storage write is, by recomputing where Solidity put it.
 *
 * A `mapping(address => …)` entry for `key` declared at slot `p` lives at
 * `keccak256(key ‖ p)`; a nested `mapping(address => mapping(address => …))`
 * entry at `keccak256(inner ‖ keccak256(outer ‖ p))`. A diff names slots, not
 * keys, and a hash cannot be inverted, so every reader here works forwards: it
 * takes the addresses a transaction could plausibly concern, computes their
 * slots once, and looks the written slots up. A match is a proof. A miss for an
 * address that was never a candidate proves nothing, which is why the
 * candidate list is bounded loudly rather than cut short in silence.
 */

import { hexToBytes, keccak256, type Address, type Hex } from "viem";

import type { StateDiff, UnsignedTransaction } from "../types.js";

/** Solidity puts mappings at low slot indices; searching past this buys nothing. */
export const MAX_MAPPING_SLOT = 32;

/**
 * How many distinct addresses one transaction may ask the readers to hash.
 *
 * Each costs 33 keccak hashes per mapping shape, about half a millisecond.
 * Ordinary calldata names a handful. Past this bound a reader either says it
 * could not look, or counts what it could not explain as unexplained; it never
 * spends seconds on calldata padded with decoys, and never drops the tail
 * without saying so.
 */
export const MAX_ADDRESS_CANDIDATES = 512;

/**
 * The fewest non-zero hex digits a scanned value needs to count as an address.
 *
 * Scanning every byte offset turns ABI padding into a stream of address-shaped
 * words like `0x…0001000000`. A real address has about 37 non-zero digits of
 * 40, and mining one with 25 zeros takes on the order of 10^20 attempts, so the
 * filter drops the noise and nothing anyone can deploy.
 */
const MIN_NONZERO_DIGITS = 16;

const ADDRESS_PADDING = "000000000000000000000000";

/**
 * Address-shaped values at every byte offset of the calldata.
 *
 * Arguments of a nested call — a smart account's `execute`, a multicall, a
 * Safe transaction — sit four bytes off the outer call's word boundaries, so a
 * scan of aligned words never sees them. Scanning every offset finds them; a
 * false candidate costs a few hashes and proves nothing.
 */
export function calldataAddresses(data: Hex): readonly Address[] {
  const body = data.slice(2).toLowerCase();
  const found = new Set<Address>();
  for (let offset = 0; offset + 64 <= body.length; offset += 2) {
    if (!body.startsWith(ADDRESS_PADDING, offset)) continue;
    const digits = body.slice(offset + 24, offset + 64);
    if (!/^[0-9a-f]{40}$/.test(digits)) continue;
    let nonzero = 0;
    for (const digit of digits) if (digit !== "0") nonzero += 1;
    if (nonzero >= MIN_NONZERO_DIGITS) found.add(`0x${digits}` as Address);
  }
  return [...found];
}

export interface AddressCandidates {
  readonly addresses: readonly Address[];
  /** More were found than {@link MAX_ADDRESS_CANDIDATES}; the rest were dropped. */
  readonly truncated: boolean;
}

/**
 * Every address a transaction could concern: its target, each account whose
 * state it changed, then whatever its calldata names. The order matters under
 * the bound, which drops the tail of the calldata scan and never an account
 * the transaction actually changed.
 */
export function transactionAddresses(
  transaction: UnsignedTransaction,
  diff: StateDiff,
): AddressCandidates {
  const ordered = new Set<Address>();
  if (transaction.to !== null) ordered.add(transaction.to.toLowerCase() as Address);
  for (const account of Object.keys(diff.pre)) ordered.add(account.toLowerCase() as Address);
  for (const account of Object.keys(diff.post)) ordered.add(account.toLowerCase() as Address);
  for (const address of calldataAddresses(transaction.data)) ordered.add(address);
  const all = [...ordered];
  return {
    addresses: all.slice(0, MAX_ADDRESS_CANDIDATES),
    truncated: all.length > MAX_ADDRESS_CANDIDATES,
  };
}

export interface MappingEntry {
  readonly key: Address;
  /** The declaration slot that places this entry, which is the proof. */
  readonly mappingSlot: number;
}

function writeWord(buffer: Uint8Array, offset: number, address: Address): void {
  buffer.fill(0, offset, offset + 12);
  buffer.set(hexToBytes(address), offset + 12);
}

function writePosition(buffer: Uint8Array, offset: number, position: number): void {
  buffer.fill(0, offset, offset + 32);
  new DataView(buffer.buffer).setUint32(offset + 28, position);
}

/** Slot → key, for each key's `mapping(address => …)` entry at slots 0‥maxSlot. */
export function mappingEntries(
  keys: Iterable<Address>,
  maxSlot = MAX_MAPPING_SLOT,
): ReadonlyMap<string, MappingEntry> {
  const entries = new Map<string, MappingEntry>();
  const buffer = new Uint8Array(64);
  for (const key of keys) {
    writeWord(buffer, 0, key);
    for (let p = 0; p <= maxSlot; p++) {
      writePosition(buffer, 32, p);
      entries.set(keccak256(buffer), { key, mappingSlot: p });
    }
  }
  return entries;
}

/**
 * Slot → inner key, for `mapping(address => mapping(address => …))` entries
 * under `outer`: `allowance[owner][spender]`, `isApprovedForAll[owner][operator]`.
 */
export function nestedMappingEntries(
  outer: Address,
  keys: Iterable<Address>,
  maxSlot = MAX_MAPPING_SLOT,
): ReadonlyMap<string, MappingEntry> {
  const buffer = new Uint8Array(64);
  const inner: Uint8Array[] = [];
  writeWord(buffer, 0, outer);
  for (let p = 0; p <= maxSlot; p++) {
    writePosition(buffer, 32, p);
    inner.push(hexToBytes(keccak256(buffer)));
  }

  const entries = new Map<string, MappingEntry>();
  for (const key of keys) {
    writeWord(buffer, 0, key);
    for (let p = 0; p <= maxSlot; p++) {
      buffer.set(inner[p]!, 32);
      entries.set(keccak256(buffer), { key, mappingSlot: p });
    }
  }
  return entries;
}
