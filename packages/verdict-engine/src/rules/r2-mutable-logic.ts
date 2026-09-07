/**
 * R2 — the code behind this address can be replaced.
 *
 * A contract audited yesterday says nothing about the contract you call today
 * if an admin can swap the implementation between those two moments. This is
 * the shape of the classic rug: deploy something benign, wait for funds, then
 * upgrade.
 *
 * The rule reads storage slots directly rather than calling `implementation()`
 * or `admin()`. Those getters are usually restricted to the admin and revert
 * for everyone else, and a proxy that wants to hide will simply not implement
 * them. The storage slots are where the proxy has to keep the values in order
 * to function at all, so they cannot be withheld.
 *
 * Every slot constant below is derived, not copied — see the accompanying
 * tests, which recompute each one from its EIP's preimage.
 */

import { keccak256, toHex, type Address, type Hex } from "viem";

import { evaluated } from "../types.js";
import type { Finding, Rule, RuleContext, RuleOutcome, StateDiff } from "../types.js";

/** `bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1)`. */
export const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const;
/** `bytes32(uint256(keccak256("eip1967.proxy.admin")) - 1)`. */
export const EIP1967_ADMIN_SLOT =
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103" as const;
/** `bytes32(uint256(keccak256("eip1967.proxy.beacon")) - 1)`. */
export const EIP1967_BEACON_SLOT =
  "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50" as const;
/** `keccak256("org.zeppelinos.proxy.implementation")` — pre-1967, still live (USDC). */
export const ZEPPELINOS_IMPLEMENTATION_SLOT =
  "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3" as const;
/** `keccak256("org.zeppelinos.proxy.admin")`. */
export const ZEPPELINOS_ADMIN_SLOT =
  "0x10d6a54a4754c8869d6886b5f5d7fbfa5b4522237ea5c60d11bc4e7a1ff9390b" as const;

const IMPLEMENTATION_SLOTS = [
  { slot: EIP1967_IMPLEMENTATION_SLOT, standard: "EIP-1967" },
  { slot: ZEPPELINOS_IMPLEMENTATION_SLOT, standard: "zeppelinos" },
] as const;

const ADMIN_SLOTS = [
  { slot: EIP1967_ADMIN_SLOT, standard: "EIP-1967" },
  { slot: ZEPPELINOS_ADMIN_SLOT, standard: "zeppelinos" },
] as const;

/** `getMinDelay()` (OpenZeppelin) and `delay()` (Compound). */
const TIMELOCK_SELECTORS: readonly { selector: Hex; flavour: string }[] = [
  { selector: "0xf27a0c92", flavour: "OpenZeppelin TimelockController" },
  { selector: "0x6a42b8f8", flavour: "Compound Timelock" },
];

/**
 * Below this a timelock does not buy a human time to react.
 *
 * Twenty-four hours is the conventional floor: shorter delays exist mainly to
 * satisfy a checklist, and a delay measured in minutes protects nobody who is
 * asleep.
 */
const MEANINGFUL_DELAY_SECONDS = 24 * 60 * 60;

/**
 * A duration a person can read at a glance.
 *
 * This string lands on a hardware wallet screen, where the reader has seconds
 * and no way to do arithmetic. "0.0 hours ago" is technically true of an
 * upgrade 87 seconds old and tells them nothing; "1 minute ago" is the whole
 * decision.
 */
export function humanDuration(seconds: number): string {
  if (seconds < 90) return `${Math.max(0, Math.round(seconds))} seconds`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = seconds / 3600;
  if (hours < 48) return `${hours.toFixed(1)} hours`;
  return `${Math.round(hours / 24)} days`;
}

const ZERO_WORD =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

/** Low 20 bytes of a storage word, or null when the slot is empty. */
function wordToAddress(word: Hex | undefined): Address | null {
  if (word === undefined || word === ZERO_WORD) return null;
  const body = word.slice(2).padStart(64, "0");
  const address = `0x${body.slice(24)}`.toLowerCase();
  if (address === "0x0000000000000000000000000000000000000000") return null;
  return address as Address;
}

/** Did this transaction itself write the implementation slot? */
function upgradedInTransaction(
  diff: StateDiff,
  target: Address,
): { slot: Hex; newImplementation: Address | null } | null {
  const storage = diff.post[target]?.storage;
  if (storage === undefined) return null;
  for (const { slot } of IMPLEMENTATION_SLOTS) {
    const written = storage[slot as Hex];
    if (written !== undefined) {
      return { slot: slot as Hex, newImplementation: wordToAddress(written) };
    }
  }
  return null;
}

/**
 * When a proxy's implementation last changed.
 *
 * An interface rather than a concrete index, so this rule does not depend on
 * Substreams — a deployment with no stream omits it and still gets every other
 * check.
 */
export interface UpgradeHistory {
  /**
   * Most recent upgrade observed for a proxy, or null.
   *
   * Null covers two different situations — never upgraded, and upgraded before
   * observation began — which is why {@link watchedSince} must be read
   * alongside it.
   */
  lastUpgrade(proxy: Address): {
    readonly block: number;
    readonly timestamp: number;
    readonly implementation: string;
  } | null;
  /** First block observed. Null before the stream has produced anything. */
  readonly watchedSince: number | null;
}

export interface MutableLogicRuleOptions {
  /** Admins a caller has decided to trust, lowercased. */
  readonly allowlist?: Iterable<Address>;
  /** Minimum delay, in seconds, that counts as real protection. */
  readonly meaningfulDelaySeconds?: number;
  /** Optional: when this proxy's logic last changed. */
  readonly upgradeHistory?: UpgradeHistory;
  /**
   * How recently an upgrade must have landed to count as recent.
   *
   * Defaults to the same 24 hours used as the meaningful-timelock floor, and
   * for the same reason: if a delay shorter than a day gives nobody time to
   * react, then an upgrade inside that window is one nobody could have reacted
   * to either. The two thresholds measure the same human latency from
   * different sides.
   */
  readonly recentUpgradeSeconds?: number;
  /** Injectable so tests do not depend on wall clock. */
  readonly now?: () => Date;
}

export class MutableLogicRule implements Rule {
  readonly id = "R2";
  readonly title = "Mutable contract logic";

  readonly #allowlist: ReadonlySet<string>;
  readonly #meaningfulDelay: number;
  readonly #upgradeHistory: UpgradeHistory | undefined;
  readonly #recentUpgradeSeconds: number;
  readonly #now: () => Date;

  constructor(options: MutableLogicRuleOptions = {}) {
    this.#upgradeHistory = options.upgradeHistory;
    this.#recentUpgradeSeconds =
      options.recentUpgradeSeconds ?? MEANINGFUL_DELAY_SECONDS;
    this.#now = options.now ?? (() => new Date());
    this.#allowlist = new Set(
      [...(options.allowlist ?? [])].map((a) => a.toLowerCase()),
    );
    this.#meaningfulDelay =
      options.meaningfulDelaySeconds ?? MEANINGFUL_DELAY_SECONDS;
  }

  async evaluate(context: RuleContext): Promise<RuleOutcome> {
    const target = context.transaction.to;
    // Contract creation has no existing code to be mutable.
    if (target === null) return evaluated([]);

    const address = target.toLowerCase() as Address;
    const proxy = await this.#readProxy(context, address);
    if (proxy === null) return evaluated([]);

    const history = this.#readUpgradeHistory(address);
    const findings: Finding[] = [];

    // An upgrade landing inside the transaction under judgement is not a
    // latent risk, it is the risk materialising right now.
    const upgrade = upgradedInTransaction(context.diff, address);
    if (upgrade !== null) {
      findings.push({
        ruleId: this.id,
        severity: "critical",
        // About this call, not about the counterparty in general.
        standing: false,
        title: "This transaction replaces the contract's implementation",
        detail:
          `The implementation slot ${upgrade.slot} of ${address} is written by this ` +
          `transaction, pointing at ${upgrade.newImplementation ?? "an unreadable value"}. ` +
          `The code that runs after this transaction is not the code that was reviewed before it.`,
        evidence: {
          proxy: address,
          implementation_slot: upgrade.slot,
          new_implementation: upgrade.newImplementation,
          derived_from: "state_diff",
        },
      });
    }

    if (proxy.admin === null) {
      // A proxy whose admin slot is empty is usually beacon- or
      // governance-controlled elsewhere. Report it rather than assume it is
      // immutable: absence of an admin here is not proof no one can upgrade.
      findings.push({
        ruleId: this.id,
        severity: "info",
        standing: true,
        title: "Contract is upgradeable, controller not visible on-chain here",
        detail:
          `${address} is a ${proxy.standard} proxy delegating to ` +
          `${proxy.implementation}, but its admin slot is empty. Upgrade authority ` +
          `is held somewhere this rule cannot see, such as a beacon or an external ` +
          `governance contract.`,
        evidence: {
          proxy: address,
          standard: proxy.standard,
          implementation: proxy.implementation,
          implementation_slot: proxy.implementationSlot,
          admin_slot_empty: true,
          upgrade_history: history.evidence,
        },
      });
      if (history.finding !== null) findings.push(history.finding);
      return evaluated(findings);
    }

    if (this.#allowlist.has(proxy.admin)) return evaluated(findings);

    const control = await this.#classifyAdmin(context, proxy.admin);
    findings.push({
      ruleId: this.id,
      severity: control.severity,
      // True of every call to this contract, so it cannot by itself be the
      // reason to refuse this one.
      standing: true,
      title: control.title,
      detail:
        `${address} is a ${proxy.standard} proxy delegating to ${proxy.implementation}. ` +
        `Its admin is ${proxy.admin}. ${control.detail}`,
      evidence: {
        proxy: address,
        standard: proxy.standard,
        implementation: proxy.implementation,
        admin: proxy.admin,
        admin_is_contract: control.isContract,
        timelock_flavour: control.flavour,
        timelock_delay_seconds: control.delaySeconds,
        upgrade_history: history.evidence,
      },
    });

    if (history.finding !== null) findings.push(history.finding);

    return evaluated(findings);
  }

  /**
   * What the stream knows about this proxy's past upgrades.
   *
   * Returns evidence for every case and a finding only for a recent upgrade.
   * Emitting a finding for "nothing seen" would attach an informational line
   * to every verdict touching any proxy, which is most of them — the
   * observation window belongs in evidence, where a reader can weigh it,
   * rather than in the finding list, where it would be noise.
   */
  #readUpgradeHistory(address: Address): {
    evidence: Readonly<Record<string, unknown>>;
    finding: Finding | null;
  } {
    const history = this.#upgradeHistory;
    if (history === undefined) {
      // Said plainly rather than omitted: a reader must be able to tell
      // "no upgrade seen" from "nobody was watching".
      return { evidence: { available: false }, finding: null };
    }

    const last = history.lastUpgrade(address);
    if (last === null) {
      return {
        evidence: {
          available: true,
          upgrade_seen: false,
          watched_since_block: history.watchedSince,
          // The distinction that keeps this honest.
          note: "No upgrade observed in the watched window. This is not evidence that none occurred earlier.",
        },
        finding: null,
      };
    }

    const secondsAgo = Math.max(
      0,
      Math.round(this.#now().getTime() / 1000) - last.timestamp,
    );
    const recent = secondsAgo <= this.#recentUpgradeSeconds;

    const evidence = {
      available: true,
      upgrade_seen: true,
      watched_since_block: history.watchedSince,
      last_upgrade_block: last.block,
      last_upgrade_implementation: last.implementation,
      seconds_since_upgrade: secondsAgo,
      recent,
      derived_from: "substreams",
    } as const;

    if (!recent) return { evidence, finding: null };

    const ago = humanDuration(secondsAgo);
    return {
      evidence,
      finding: {
        ruleId: this.id,
        severity: "critical",
        /*
         * Still a standing property, so still capped at medium by policy.
         *
         * That cap is deliberate. Protocols upgrade routinely, and refusing
         * every interaction with one that shipped a release this morning would
         * block far more honest transactions than malicious ones. What a
         * recent upgrade earns is a human looking at it — which is exactly
         * what medium means — and the detail below is written to be read on a
         * device screen, because that is where the decision gets made.
         */
        standing: true,
        title: `Implementation changed ${ago} ago`,
        detail:
          `${address} was pointed at a new implementation ` +
          `(${last.implementation}) at block ${last.block}, ${ago} ago. ` +
          "Any review of this contract older than that describes code which is " +
          "no longer running.",
        evidence,
      },
    };
  }

  async #readProxy(
    context: RuleContext,
    address: Address,
  ): Promise<{
    implementation: Address;
    implementationSlot: Hex;
    standard: string;
    admin: Address | null;
  } | null> {
    for (const { slot, standard } of IMPLEMENTATION_SLOTS) {
      const implementation = wordToAddress(
        await context.getStorageAt(address, slot as Hex),
      );
      if (implementation === null) continue;

      let admin: Address | null = null;
      for (const candidate of ADMIN_SLOTS) {
        admin = wordToAddress(
          await context.getStorageAt(address, candidate.slot as Hex),
        );
        if (admin !== null) break;
      }

      return { implementation, implementationSlot: slot as Hex, standard, admin };
    }

    // Beacon proxies keep the implementation one hop away.
    const beacon = wordToAddress(
      await context.getStorageAt(address, EIP1967_BEACON_SLOT),
    );
    if (beacon !== null) {
      return {
        implementation: beacon,
        implementationSlot: EIP1967_BEACON_SLOT,
        standard: "EIP-1967 beacon",
        admin: null,
      };
    }

    return null;
  }

  /** How much protection stands between the admin and an instant upgrade. */
  async #classifyAdmin(
    context: RuleContext,
    admin: Address,
  ): Promise<{
    severity: Finding["severity"];
    title: string;
    detail: string;
    isContract: boolean;
    flavour: string | null;
    delaySeconds: number | null;
  }> {
    const code = await context.getCode(admin);
    const isContract = code !== "0x" && code.length > 2;

    if (!isContract) {
      return {
        severity: "critical",
        title: "Upgradeable contract controlled by a single key",
        detail:
          "The admin is an externally owned account, so one private key can replace " +
          "the implementation in a single transaction with no delay and no notice.",
        isContract: false,
        flavour: null,
        delaySeconds: null,
      };
    }

    for (const { selector, flavour } of TIMELOCK_SELECTORS) {
      const result = await context.call(admin, selector);
      if (result === null || result === "0x") continue;
      const delaySeconds = Number(BigInt(result));
      if (!Number.isFinite(delaySeconds) || delaySeconds <= 0) continue;

      if (delaySeconds >= this.#meaningfulDelay) {
        return {
          severity: "info",
          title: "Upgradeable contract behind a timelock",
          detail:
            `The admin is a ${flavour} enforcing a ${delaySeconds}s delay, so an upgrade ` +
            "is visible on-chain before it takes effect.",
          isContract: true,
          flavour,
          delaySeconds,
        };
      }
      return {
        severity: "warning",
        title: "Upgradeable contract behind a short timelock",
        detail:
          `The admin is a ${flavour}, but its ${delaySeconds}s delay is under the ` +
          `${this.#meaningfulDelay}s threshold and leaves little time to react.`,
        isContract: true,
        flavour,
        delaySeconds,
      };
    }

    return {
      severity: "warning",
      title: "Upgradeable contract with no detectable timelock",
      detail:
        "The admin is a contract, but exposes no recognised timelock interface, so " +
        "no enforced delay could be established. It may be a multisig or custom " +
        "governance; that is not verifiable from here.",
      isContract: true,
      flavour: null,
      delaySeconds: null,
    };
  }
}

/** Recompute an EIP-1967 slot from its label, used by the tests. */
export function eip1967Slot(label: string): Hex {
  return toHex(BigInt(keccak256(toHex(label))) - 1n, { size: 32 });
}
