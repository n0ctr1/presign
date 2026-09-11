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
import {
  toIncidentRegistry,
  type IncidentRegistry,
} from "../incidents/incident-registry.js";

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
  /**
   * Spenders known to be involved in incidents: a maintained feed such as
   * {@link ScamSnifferIncidentFeed}, or a plain list of addresses.
   */
  readonly incidentRegistry?: Iterable<Address> | IncidentRegistry;
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
  readonly #incidents: IncidentRegistry;
  readonly #maxMappingSlot: number;

  constructor(options: UnlimitedApprovalRuleOptions = {}) {
    this.#allowlist = new Set(
      [...(options.allowlist ?? [])].map((a) => a.toLowerCase()),
    );
    this.#incidents = toIncidentRegistry(options.incidentRegistry);
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

    /*
     * Candidates on the incident registry are checked at any amount.
     *
     * A bounded approval to an ordinary spender is a considered budget and
     * not this rule's business. The same approval to an address reported for
     * phishing is not a budget: the limit caps what it can take, it does not
     * make handing it an allowance reasonable. Searching only the flagged
     * candidates for sub-threshold writes keeps the ordinary case as cheap as
     * it was.
     */
    const flaggedCandidates = [...spenders].filter((s) => this.#incidents.has(s));

    for (const [token, account] of Object.entries(diff.post)) {
      for (const [slot, rawValue] of Object.entries(account.storage ?? {})) {
        const value = BigInt(rawValue);
        // Zero is a revocation, which is the opposite of a risk.
        if (value === 0n) continue;
        const unlimited = value >= UNLIMITED_THRESHOLD;
        if (!unlimited && flaggedCandidates.length === 0) continue;

        const match = this.#identifySpender(
          owner,
          unlimited ? spenders : flaggedCandidates,
          slot as Hex,
        );
        if (match === null) continue;
        if (this.#allowlist.has(match.spender)) continue;

        const flagged = this.#incidents.has(match.spender);
        const registry = flagged ? this.#incidents.status() : null;
        const amount = value === 2n ** 256n - 1n ? "type(uint256).max" : value.toString();
        findings.push({
          ruleId: this.id,
          severity: flagged ? "critical" : "warning",
          // This transaction grants the allowance; it is not a pre-existing
          // property of the counterparty.
          standing: false,
          title: flagged
            ? unlimited
              ? "Unlimited approval to an address linked to a known incident"
              : "Approval to an address linked to a known incident"
            : "Unlimited token approval to an unrecognised spender",
          detail:
            `This transaction sets allowance[${owner}][${match.spender}] on token ` +
            `${token} to ${amount}. ` +
            (unlimited
              ? "The spender may move the full balance at any time, indefinitely."
              : "The amount caps the loss, not the risk.") +
            (registry === null
              ? ""
              : ` This spender is listed by ${registry.source}` +
                (registry.fetchedAt === null ? "." : `, as fetched at ${registry.fetchedAt}.`)),
          evidence: {
            ...(registry === null
              ? {}
              : {
                  incident_registry: {
                    source: registry.source,
                    url: registry.url,
                    entries: registry.entries,
                    fetched_at: registry.fetchedAt,
                  },
                }),
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
