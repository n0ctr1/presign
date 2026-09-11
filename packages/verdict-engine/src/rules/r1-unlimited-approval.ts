/**
 * R1 — approvals that hand a spender the balance, and value handed to
 * addresses linked to known incidents.
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
 *
 * An allowance is reported when it is at least 2^128, beyond any real supply;
 * when it is at least the token's total supply, which no budget ever needs and
 * which is what catches 2^127 or any figure chosen to sit under a fixed bar; or
 * when it covers the owner's entire current balance. `setApprovalForAll` on
 * ERC-721 and ERC-1155 uses the same nested layout and writes `true`, so a
 * written 1 that the contract confirms through `isApprovedForAll` is reported
 * as an operator approval over the whole collection.
 *
 * Any approval to an address on the incident registry is critical at any
 * amount, and so is a transaction that calls a listed address or pays one ETH
 * or tokens: the list names addresses, and whether one is reached through an
 * allowance or a transfer changes nothing about it.
 *
 * Spenders are searched for among the transaction's target, every account it
 * changed, and address-shaped words at every byte offset of the calldata,
 * which is how an approval nested inside a smart account's `execute` is found.
 * What this does not see: a spender packed into calldata without ABI padding
 * and touched nowhere in state, and allowances kept in another layout —
 * Permit2's triple mapping, Solady's packed slots.
 */

import { concat, keccak256, pad, toHex, type Address, type Hex } from "viem";

import { evaluated } from "../types.js";
import type { Finding, Rule, RuleContext, RuleOutcome } from "../types.js";
import {
  toIncidentRegistry,
  type IncidentRegistry,
} from "../incidents/incident-registry.js";
import { valueEffects } from "../simulation/effects.js";
import {
  MAX_ADDRESS_CANDIDATES,
  MAX_MAPPING_SLOT,
  nestedMappingEntries,
  transactionAddresses,
} from "../simulation/mappings.js";

/**
 * Above this, an allowance cannot be a considered budget.
 *
 * Every real ERC-20 supply fits far below 2^128: a trillion units at 18
 * decimals is about 10^30, roughly 2^100. It is the bar that needs no call to
 * the token; the total-supply comparison below is the one that cannot be
 * evaded by picking a number just under it.
 */
const UNLIMITED_THRESHOLD = 2n ** 128n;
const MAX_UINT256 = 2n ** 256n - 1n;

const TOTAL_SUPPLY = "0x18160ddd";
const BALANCE_OF = "0x70a08231";
const IS_APPROVED_FOR_ALL = "0xe985e9c5";

export interface UnlimitedApprovalRuleOptions {
  /** Spenders a caller has decided are acceptable, lowercased. */
  readonly allowlist?: Iterable<Address>;
  /**
   * Addresses known to be involved in incidents: a maintained feed such as
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

/** Why an allowance counts as handing over the balance. */
type UnlimitedBasis = "at_least_2^128" | "at_least_total_supply" | "covers_balance";

type Grant =
  | { readonly kind: "operator" }
  | {
      readonly kind: "allowance";
      readonly basis: UnlimitedBasis | null;
      readonly totalSupply: bigint | null;
      readonly ownerBalance: bigint | null;
    };

const word = (address: Address) => pad(address, { size: 32 }).slice(2);

/** A single uint256 return value, or null for anything else. */
function uintResult(result: Hex | null): bigint | null {
  if (result === null || result.length !== 66) return null;
  return BigInt(result);
}

export class UnlimitedApprovalRule implements Rule {
  readonly id = "R1";
  readonly title = "Token approvals and flagged addresses";

  readonly #allowlist: ReadonlySet<string>;
  readonly #incidents: IncidentRegistry;
  readonly #hasRegistry: boolean;
  readonly #maxMappingSlot: number;

  constructor(options: UnlimitedApprovalRuleOptions = {}) {
    this.#allowlist = new Set(
      [...(options.allowlist ?? [])].map((a) => a.toLowerCase()),
    );
    this.#incidents = toIncidentRegistry(options.incidentRegistry);
    this.#hasRegistry = options.incidentRegistry !== undefined;
    this.#maxMappingSlot = options.maxMappingSlot ?? MAX_MAPPING_SLOT;
  }

  async evaluate(context: RuleContext): Promise<RuleOutcome> {
    const { transaction, diff } = context;

    // A reverted transaction changes nothing. Reporting an approval that never
    // lands would train a caller to ignore this rule.
    if (diff.revertReason !== null) return evaluated([]);

    const owner = transaction.from.toLowerCase() as Address;
    const candidates = transactionAddresses(transaction, diff);

    // A spender past the bound would be a spender never checked, and "found
    // no approval" would then be a claim about addresses nobody looked at.
    if (candidates.truncated) {
      return {
        status: "unavailable",
        reason: "too_many_candidates",
        detail:
          `The transaction names more than ${MAX_ADDRESS_CANDIDATES} distinct addresses, ` +
          "so an allowance to one of the rest could not be ruled out.",
      };
    }

    const allowances = nestedMappingEntries(owner, candidates.addresses, this.#maxMappingSlot);
    const findings: Finding[] = [];

    for (const [rawToken, account] of Object.entries(diff.post)) {
      const token = rawToken.toLowerCase() as Address;
      for (const [slot, rawValue] of Object.entries(account.storage ?? {})) {
        const value = BigInt(rawValue);
        // Zero is a revocation, which is the opposite of a risk.
        if (value === 0n) continue;
        const match = allowances.get(slot.toLowerCase());
        if (match === undefined) continue;
        const spender = match.key;
        if (this.#allowlist.has(spender)) continue;

        const listed = this.#incidents.has(spender);
        const grant = await this.#classify(context, token, owner, spender, value);
        // A bounded allowance to an ordinary spender is a considered budget and
        // not this rule's business. The same allowance to a listed address is
        // not a budget: the limit caps what it can take, not whether handing it
        // an allowance is reasonable.
        if (!listed && grant.kind === "allowance" && grant.basis === null) continue;

        findings.push(
          this.#approvalFinding({ token, owner, spender, slot, rawValue, value, grant, listed, mappingSlot: match.mappingSlot }),
        );
      }
    }

    findings.push(...this.#reachedListedAddresses(context));

    // The list is named on every verdict it was consulted for, with the copy's
    // fetch time, so its age travels with the answer rather than living only
    // on /health.
    if (!this.#hasRegistry) return evaluated(findings);
    const status = this.#incidents.status();
    return evaluated(findings, undefined, [
      {
        source: status.source,
        url: status.url,
        entries: status.entries,
        fetchedAt: status.fetchedAt,
      },
    ]);
  }

  /**
   * What the written value grants, asked of the token at the forked block.
   *
   * The reads cost nothing for ordinary transactions: they happen only for a
   * write already proven to be an allowance entry for this owner.
   */
  async #classify(
    context: RuleContext,
    token: Address,
    owner: Address,
    spender: Address,
    value: bigint,
  ): Promise<Grant> {
    // `true` in `isApprovedForAll[owner][operator]` is a 1 in the same layout
    // as an allowance. The contract answering `isApprovedForAll` tells an
    // operator approval from a one-unit allowance on a token.
    if (value === 1n) {
      const answer = await context.call(token, `${IS_APPROVED_FOR_ALL}${word(owner)}${word(spender)}`);
      if (answer !== null && answer.length === 66) return { kind: "operator" };
    }

    if (value >= UNLIMITED_THRESHOLD) {
      return { kind: "allowance", basis: "at_least_2^128", totalSupply: null, ownerBalance: null };
    }

    const [totalSupply, ownerBalance] = await Promise.all([
      context.call(token, TOTAL_SUPPLY).then(uintResult),
      context.call(token, `${BALANCE_OF}${word(owner)}`).then(uintResult),
    ]);
    const basis: UnlimitedBasis | null =
      totalSupply !== null && totalSupply > 0n && value >= totalSupply
        ? "at_least_total_supply"
        : ownerBalance !== null && ownerBalance > 0n && value >= ownerBalance
          ? "covers_balance"
          : null;
    return { kind: "allowance", basis, totalSupply, ownerBalance };
  }

  #approvalFinding(write: {
    token: Address;
    owner: Address;
    spender: Address;
    slot: string;
    rawValue: string;
    value: bigint;
    grant: Grant;
    listed: boolean;
    mappingSlot: number;
  }): Finding {
    const { token, owner, spender, value, grant, listed } = write;
    const registry = listed ? this.#incidents.status() : null;
    const unlimited =
      grant.kind === "allowance" &&
      (grant.basis === "at_least_2^128" || grant.basis === "at_least_total_supply");
    const amount = value === MAX_UINT256 ? "type(uint256).max" : value.toString();

    let title: string;
    let detail: string;
    if (grant.kind === "operator") {
      title = listed
        ? "Operator approval to an address linked to a known incident"
        : "Operator approval over a whole collection to an unrecognised operator";
      detail =
        `This transaction makes ${spender} an operator for ${owner} on ${token}: it may ` +
        "transfer every token of that collection the owner holds now or receives later.";
    } else {
      title = listed
        ? unlimited
          ? "Unlimited approval to an address linked to a known incident"
          : "Approval to an address linked to a known incident"
        : grant.basis === "covers_balance"
          ? "Approval of the entire token balance to an unrecognised spender"
          : "Unlimited token approval to an unrecognised spender";
      const consequence =
        grant.basis === "at_least_2^128"
          ? "The spender may move the full balance at any time, indefinitely."
          : grant.basis === "at_least_total_supply"
            ? `That is at least the token's entire supply of ${grant.totalSupply}, so no balance ` +
              "could exhaust it: the spender may move the full balance at any time, indefinitely."
            : grant.basis === "covers_balance"
              ? `That covers the owner's whole current balance of ${grant.ownerBalance}.`
              : "The amount caps the loss, not the risk.";
      detail =
        `This transaction sets allowance[${owner}][${spender}] on token ${token} to ${amount}. ` +
        consequence;
    }
    if (registry !== null) {
      detail +=
        ` This address is listed by ${registry.source}` +
        (registry.fetchedAt === null ? "." : `, as fetched at ${registry.fetchedAt}.`);
    }

    return {
      ruleId: this.id,
      severity: listed ? "critical" : "warning",
      // This transaction grants the allowance; it is not a pre-existing
      // property of the counterparty.
      standing: false,
      title,
      detail,
      evidence: {
        ...this.#registryEvidence(registry),
        token,
        owner,
        spender,
        approval_kind: grant.kind,
        ...(grant.kind === "allowance"
          ? {
              unlimited_basis: grant.basis,
              total_supply: grant.totalSupply?.toString() ?? null,
              owner_balance: grant.ownerBalance?.toString() ?? null,
            }
          : {}),
        // The proof: this slot is the mapping entry, and here is the mapping
        // position that demonstrates it.
        storage_slot: write.slot,
        mapping_slot: write.mappingSlot,
        new_value: write.rawValue,
        is_exact_max: value === MAX_UINT256,
        derived_from: "state_diff",
      },
    };
  }

  /**
   * Listed addresses the transaction calls or pays, whatever the mechanism.
   *
   * Recipients come from the effects the engine already read from the diff,
   * so a transfer nested inside a batch is caught the same way as a direct
   * one. A listed address merely mentioned in calldata is not reported:
   * revoking a drainer's allowance names the drainer too.
   */
  #reachedListedAddresses(context: RuleContext): Finding[] {
    const { transaction, diff } = context;
    const effects = context.effects ?? valueEffects(transaction, diff);

    const reached = new Map<Address, { called: boolean; eth: boolean; tokens: Address[] }>();
    const entry = (address: Address) => {
      const key = address.toLowerCase() as Address;
      let found = reached.get(key);
      if (found === undefined) {
        found = { called: false, eth: false, tokens: [] };
        reached.set(key, found);
      }
      return found;
    };
    if (transaction.to !== null) entry(transaction.to as Address).called = true;
    for (const recipient of effects.ethRecipients) entry(recipient).eth = true;
    for (const token of effects.tokensOut) {
      for (const recipient of token.recipients) entry(recipient).tokens.push(token.token);
    }

    const findings: Finding[] = [];
    for (const [address, how] of reached) {
      if (!this.#incidents.has(address)) continue;
      const registry = this.#incidents.status();
      const paid = how.eth || how.tokens.length > 0;
      const ways = [
        ...(how.called ? ["is the address this transaction calls"] : []),
        ...(how.eth ? ["receives ETH from the sender"] : []),
        ...(how.tokens.length > 0 ? [`receives the sender's tokens of ${how.tokens.join(", ")}`] : []),
      ];
      findings.push({
        ruleId: this.id,
        severity: "critical",
        standing: false,
        title: paid
          ? "Sends value to an address linked to a known incident"
          : "Calls an address linked to a known incident",
        detail:
          `${address} ${ways.join(" and ")}. It is listed by ${registry.source}` +
          (registry.fetchedAt === null ? "." : `, as fetched at ${registry.fetchedAt}.`),
        evidence: {
          ...this.#registryEvidence(registry),
          address,
          called: how.called,
          receives_eth: how.eth,
          receives_tokens: how.tokens,
          derived_from: how.called && !paid ? "transaction_target" : "state_diff",
        },
      });
    }
    return findings;
  }

  #registryEvidence(registry: ReturnType<IncidentRegistry["status"]> | null) {
    return registry === null
      ? {}
      : {
          incident_registry: {
            source: registry.source,
            url: registry.url,
            entries: registry.entries,
            fetched_at: registry.fetchedAt,
          },
        };
  }
}
