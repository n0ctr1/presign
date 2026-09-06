/**
 * R1 — unlimited token approval to a spender outside the allowlist.
 *
 * The naive implementation decodes `approve(spender, amount)` from the
 * calldata and checks the amount. That catches the direct case and misses
 * every indirect one: a router, a batch, a multicall or a `permit` forwarded
 * on the owner's behalf shows nothing useful on the surface while writing an
 * unmistakable allowance in the state.
 *
 * So this rule works backwards from the diff. It takes each storage slot the
 * transaction actually wrote, and tries to prove the slot *is* the allowance
 * for a specific (owner, spender) pair by recomputing the mapping address:
 *
 *     slot = keccak256(spender ‖ keccak256(owner ‖ p))
 *
 * for each plausible mapping position `p`. A match is not a heuristic — it is
 * a proof that this exact slot is `allowance[owner][spender]` under Solidity's
 * mapping layout, and it needs no per-token configuration. Verified against
 * USDC, whose allowance mapping sits at p = 10 and is recovered by search.
 */

import { concat, keccak256, pad, toHex, type Address, type Hex } from "viem";

import { evaluated } from "../types.js";
import type { Finding, Rule, RuleContext, RuleOutcome } from "../types.js";

/**
 * Above this, an allowance cannot be a considered budget.
 *
 * Every real ERC-20 supply fits far below 2^128: a trillion units at 18
 * decimals is about 10^30, roughly 2^100. Matching only `type(uint256).max`
 * would miss the common evasion of approving 2^255 or similar, which is
 * unlimited in every practical sense.
 */
const UNLIMITED_THRESHOLD = 2n ** 128n;

/** Solidity puts mappings at low slot indices; searching past this buys nothing. */
const DEFAULT_MAX_MAPPING_SLOT = 32;

export interface UnlimitedApprovalRuleOptions {
  /** Spenders a caller has decided are acceptable, lowercased. */
  readonly allowlist?: Iterable<Address>;
  /** Spenders known to be involved in incidents, lowercased. */
  readonly incidentRegistry?: Iterable<Address>;
  readonly maxMappingSlot?: number;
}

/** `allowance[owner][spender]` under Solidity's nested-mapping layout. */
export function allowanceSlot(
  owner: Address,
  spender: Address,
  mappingSlot: number,
): Hex {
  const inner = keccak256(
    concat([pad(owner, { size: 32 }), pad(toHex(mappingSlot), { size: 32 })]),
  );
  return keccak256(concat([pad(spender, { size: 32 }), inner]));
}

/**
 * Address-shaped 32-byte words in the calldata.
 *
 * Used only to bound the spender search. A word that is not an address costs a
 * few hashes and proves nothing, so being generous here is cheap; missing the
 * real spender is not.
 */
export function addressCandidates(data: Hex): readonly Address[] {
  const body = data.slice(10); // strip 0x and the 4-byte selector
  const found = new Set<Address>();
  for (let offset = 0; offset + 64 <= body.length; offset += 64) {
    const word = body.slice(offset, offset + 64);
    // An address occupies the low 20 bytes; the high 12 must be zero.
    if (!/^0{24}[0-9a-fA-F]{40}$/.test(word)) continue;
    const address = `0x${word.slice(24)}`.toLowerCase() as Address;
    if (address !== "0x0000000000000000000000000000000000000000") {
      found.add(address);
    }
  }
  return [...found];
}

export class UnlimitedApprovalRule implements Rule {
  readonly id = "R1";
  readonly title = "Unlimited token approval";

  readonly #allowlist: ReadonlySet<string>;
  readonly #incidents: ReadonlySet<string>;
  readonly #maxMappingSlot: number;

  constructor(options: UnlimitedApprovalRuleOptions = {}) {
    this.#allowlist = new Set(
      [...(options.allowlist ?? [])].map((a) => a.toLowerCase()),
    );
    this.#incidents = new Set(
      [...(options.incidentRegistry ?? [])].map((a) => a.toLowerCase()),
    );
    this.#maxMappingSlot = options.maxMappingSlot ?? DEFAULT_MAX_MAPPING_SLOT;
  }

  evaluate(context: RuleContext): Promise<RuleOutcome> {
    const { transaction, diff } = context;

    // A reverted transaction changes nothing. Reporting an approval that never
    // lands would train a caller to ignore this rule.
    if (diff.revertReason !== null) return Promise.resolve(evaluated([]));

    const owner = transaction.from.toLowerCase() as Address;
    const spenders = new Set<Address>(addressCandidates(transaction.data));
    if (transaction.to !== null) {
      spenders.add(transaction.to.toLowerCase() as Address);
    }
    for (const address of Object.keys(diff.post)) {
      spenders.add(address.toLowerCase() as Address);
    }

    const findings: Finding[] = [];

    for (const [token, account] of Object.entries(diff.post)) {
      for (const [slot, rawValue] of Object.entries(account.storage ?? {})) {
        const value = BigInt(rawValue);
        if (value < UNLIMITED_THRESHOLD) continue;

        const match = this.#identifySpender(owner, spenders, slot as Hex);
        if (match === null) continue;
        if (this.#allowlist.has(match.spender)) continue;

        const flagged = this.#incidents.has(match.spender);
        findings.push({
          ruleId: this.id,
          severity: flagged ? "critical" : "warning",
          title: flagged
            ? "Unlimited approval to an address linked to a known incident"
            : "Unlimited token approval to an unrecognised spender",
          detail:
            `This transaction sets allowance[${owner}][${match.spender}] on token ` +
            `${token} to ${value === 2n ** 256n - 1n ? "type(uint256).max" : value.toString()}. ` +
            `The spender may move the full balance at any time, indefinitely.` +
            (flagged ? " This spender appears in the incident registry." : ""),
          evidence: {
            token,
            owner,
            spender: match.spender,
            // The proof: this slot is the allowance mapping entry, and here is
            // the mapping position that demonstrates it.
            storage_slot: slot,
            mapping_slot: match.mappingSlot,
            new_value: rawValue,
            is_exact_max: value === 2n ** 256n - 1n,
            derived_from: "state_diff",
          },
        });
      }
    }

    return Promise.resolve(evaluated(findings));
  }

  /** Which candidate spender, if any, this slot is the allowance for. */
  #identifySpender(
    owner: Address,
    spenders: Iterable<Address>,
    slot: Hex,
  ): { spender: Address; mappingSlot: number } | null {
    const target = slot.toLowerCase();
    for (const spender of spenders) {
      for (let p = 0; p <= this.#maxMappingSlot; p++) {
        if (allowanceSlot(owner, spender, p).toLowerCase() === target) {
          return { spender, mappingSlot: p };
        }
      }
    }
    return null;
  }
}
