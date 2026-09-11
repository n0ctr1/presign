/**
 * R4 — nobody can tell us what this counterparty is.
 *
 * R1, R2 and R3 all answer questions about a contract someone already knows
 * something about: an allowance in the diff, a proxy slot, a protocol's
 * accounting. Every one of them is silent about the case that motivates the
 * whole project — an agent about to sign a call to a contract that was
 * deployed this morning and that no one has ever indexed. Before this rule
 * existed, that transaction came back `low`, because three rules looking for
 * three specific things had each honestly found nothing.
 *
 * That is the same fail-open the `unavailable` tier exists to prevent, arriving
 * by a different route. `unavailable` covers "we could not see"; this rule
 * covers "we saw, and there was nothing there to see" — an absence of
 * corroboration, which is itself the finding rather than the lack of one.
 *
 * Two facts are established, and only two, because they are the two that can
 * be checked by the reader:
 *
 *   1. No deployment in the registry indexes this address. Note the shape of
 *      that claim. It is not "this contract is unknown", which is unfalsifiable
 *      and which we have no standing to assert; it is a statement about a named
 *      registry, and anyone can query it and get the same answer.
 *   2. Code first appeared at the address at a particular block, or at least
 *      before some block. See {@link ContractOrigin} for why those are kept
 *      apart.
 *
 * Both facts are established about the address whose code actually *runs*,
 * which is not always the address being called. An EIP-7702 account is an EOA
 * carrying a delegation to a contract that holds its behaviour, and asking a
 * subgraph registry to identify a user's wallet is a question with only one
 * answer. Reading the delegation is therefore not a refinement — without it
 * this rule would report every smart account as an unidentified contract, and
 * every account delegated in the last week as `high`. Agent wallets are
 * precisely the accounts that carry these delegations.
 *
 * Neither fact is about the transaction under judgement — both are true of
 * every call to this counterparty — so the findings are `standing`. They are
 * nonetheless left uncapped by the default tier policy, unlike R2's. The
 * argument for capping R2 is that upgradeability is true of most of DeFi,
 * USDC included, so letting it reach `high` would refuse honest transactions
 * until the caller learned to ignore the verdict. Being unindexed *and* days
 * old is not true of most of DeFi; it is close to the definition of the thing
 * an agent should refuse to sign unsupervised.
 */

import { evaluated } from "../types.js";
import type {
  Address,
  Finding,
  Hex,
  Rule,
  RuleContext,
  RuleOutcome,
} from "../types.js";
import type { ContractOrigin, ContractOriginSource } from "../chain/contract-origin.js";
import { CHAIN_TO_NETWORK } from "./r3-invariant-breach.js";
import { humanDuration } from "./r2-mutable-logic.js";
import type { DeploymentCandidate, NetworkId } from "@presign/operational-layer";

/**
 * Below this age, an unindexed counterparty is treated as fresh.
 *
 * Seven days is not a risk model, it is an exposure window. A contract that
 * has been on chain for less than a week has not yet been through one cycle of
 * the people who publish incident reports, so nobody has had the chance to
 * index it, write about it, or complain about it — and its absence from every
 * registry says nothing at all. Past that point the same absence starts to
 * mean something else: not "too new to be known" but "old enough to be known
 * and still isn't", which is a coverage gap rather than a fresh-deployment
 * signal, and a human looking at it is the proportionate response.
 *
 * The drainer pattern this is aimed at lives well inside the window. Deploy,
 * solicit approvals, drain, abandon — measured in hours, not weeks.
 */
export const DEFAULT_FRESH_DEPLOYMENT_SECONDS = 7 * 24 * 60 * 60;
/**
 * Why an old unindexed contract is reported but does not raise the tier.
 *
 * The first version of this rule charged `warning` — a human confirmation on
 * the device — for any unindexed counterparty past the window, reasoning that
 * a contract old enough to be known and still absent from every registry was
 * a coverage gap worth a second look. Running the rule over contracts nobody
 * disputes showed that reasoning is wrong.
 *
 * Multicall3, Permit2 and Uniswap's router are indexed by nothing. Not because
 * they are obscure — a large share of Ethereum transactions touch them — but
 * because indexing tracks whether a contract emits events somebody wants to
 * query, not whether it can be trusted. Immutable utility contracts are
 * systematically unindexed, so treating absence as a signal charges friction
 * to exactly the contracts an agent meets most often, and a verdict that asks
 * for a human on Multicall3 is one people learn to click through.
 *
 * The finding is still reported, because "nothing independent describes this"
 * is true and worth a reader seeing. It simply stops being a reason to stop.
 * The argument survives intact where it was always strong: deployed hours ago
 * *and* corroborated by nobody. That combination is not true of infrastructure
 * and stays critical.
 */


/**
 * Selectors whose meaning is a convention rather than a guarantee.
 *
 * Kept deliberately short. The point is not to decode calldata — without an
 * ABI that is not possible, and pretending otherwise would be exactly the kind
 * of unverifiable claim this project is arguing against. The point is that on
 * an *unidentified* contract a familiar selector is the least trustworthy
 * thing in the transaction: matching `approve(address,uint256)` costs an
 * attacker nothing and is what makes a malicious clone look ordinary in a
 * wallet UI.
 */
const CONVENTIONAL_SELECTORS: Readonly<Record<string, string>> = {
  "0x095ea7b3": "approve(address,uint256)",
  "0xa9059cbb": "transfer(address,uint256)",
  "0x23b872dd": "transferFrom(address,address,uint256)",
  "0xd0e30db0": "deposit()",
  "0x2e1a7d4d": "withdraw(uint256)",
  "0x3593564c": "execute(bytes,bytes[],uint256)",
};

/**
 * The identification half of the operational layer, narrowed to what R4 reads.
 *
 * `ProtocolContext` satisfies this structurally, so the rule shares the one
 * instance the pipeline already builds, but it cannot reach the query or probe
 * methods it has no business calling.
 */
export interface CounterpartyDirectory {
  findIndexingDeployments(
    address: Address,
    network: NetworkId,
  ): Promise<readonly DeploymentCandidate[]>;
}

export interface UnidentifiedCounterpartyRuleOptions {
  readonly directory: CounterpartyDirectory;
  readonly origin: ContractOriginSource;
  /** Age below which an unindexed counterparty counts as freshly deployed. */
  readonly freshDeploymentSeconds?: number;
  /** Injectable so tests do not depend on wall clock. */
  readonly now?: () => Date;
}

/** Empty calldata is `0x`; anything longer carries at least a partial selector. */
function selectorOf(data: Hex): Hex | null {
  return data.length >= 10 ? (data.slice(0, 10).toLowerCase() as Hex) : null;
}

/**
 * EIP-7702 marks a delegated account with `0xef0100 || delegate` as its code:
 * three bytes of indicator and twenty of address, twenty-three in total.
 */
const DELEGATION_PREFIX = "0xef0100";
const DELEGATION_CODE_LENGTH = 2 + 6 + 40;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * The contract an EIP-7702 account delegates to, or null if this is not one.
 *
 * A delegation cleared back to the zero address also returns null: such an
 * account executes nothing and is an ordinary EOA again, so treating it as a
 * counterparty with code would invent a contract that is not there.
 */
function delegateOf(code: Hex): Address | null {
  const lower = code.toLowerCase();
  if (!lower.startsWith(DELEGATION_PREFIX)) return null;
  if (lower.length !== DELEGATION_CODE_LENGTH) return null;
  const delegate = `0x${lower.slice(8)}`;
  return delegate === ZERO_ADDRESS ? null : (delegate as Address);
}

export class UnidentifiedCounterpartyRule implements Rule {
  readonly id = "R4";
  readonly title = "Unidentified counterparty";

  readonly #directory: CounterpartyDirectory;
  readonly #origin: ContractOriginSource;
  readonly #freshSeconds: number;
  readonly #now: () => Date;

  constructor(options: UnidentifiedCounterpartyRuleOptions) {
    this.#directory = options.directory;
    this.#origin = options.origin;
    this.#freshSeconds =
      options.freshDeploymentSeconds ?? DEFAULT_FRESH_DEPLOYMENT_SECONDS;
    this.#now = options.now ?? (() => new Date());
  }

  async evaluate(context: RuleContext): Promise<RuleOutcome> {
    const { transaction } = context;
    // Deploying a contract is not calling an unknown one. It has its own risk
    // story and no counterparty for this rule to identify.
    if (transaction.to === null) return evaluated([]);

    const target = transaction.to.toLowerCase() as Address;
    const selector = selectorOf(transaction.data);

    const code = await context.getCode(target);
    const delegate = code.length > 2 ? delegateOf(code) : null;

    // A bare EOA, or one whose 7702 delegation has been cleared: nothing here
    // executes, and there is no counterparty for a registry to describe.
    if (code.length <= 2 || (code.toLowerCase().startsWith(DELEGATION_PREFIX) && delegate === null)) {
      return evaluated(this.#findingsForCodelessTarget(target, selector));
    }

    /*
     * From here the subject is the address whose code runs, which for a
     * delegated account is the delegate rather than the account. Identifying
     * the account itself would be a category error with a predictable outcome:
     * no subgraph indexes anyone's wallet, so every smart account would come
     * back unidentified.
     */
    const subject = delegate ?? target;

    const network = CHAIN_TO_NETWORK[transaction.chainId];
    if (network === undefined) {
      return {
        status: "unavailable",
        reason: "unsupported_network",
        detail:
          `no contract registry is configured for chain ${transaction.chainId}, so ` +
          "this counterparty could not be identified either way",
      };
    }

    let indexing: readonly DeploymentCandidate[];
    try {
      indexing = await this.#directory.findIndexingDeployments(subject, network);
    } catch (error) {
      /*
       * The registry being unreachable is the fail-closed case, and getting
       * this arm wrong in either direction is a real defect. Reporting
       * "unidentified" would raise a high verdict on Aave every time discovery
       * hiccuped; reporting nothing would clear an actual drainer because a
       * lookup timed out. Neither is a conclusion, so the rule declines to
       * reach one.
       */
      return {
        status: "unavailable",
        reason: "identification_unavailable",
        detail: error instanceof Error ? error.message : String(error),
      };
    }

    /*
     * At least one subgraph manifest names this address. That is weaker than
     * it looks and is used only as weakly: it establishes that somebody built
     * indexing infrastructure pointing at this contract, not what the contract
     * is. USDC being indexed by Hop does not make USDC a bridge. Identifying
     * *what* the counterparty is belongs to R3, which insists on conformance
     * before it will believe a classification.
     */
    const delegation =
      delegate === null ? [] : [this.#delegationFinding(target, delegate)];

    if (indexing.length > 0) return evaluated(delegation);

    const origin = await this.#origin.originOf(subject);
    return evaluated([
      ...delegation,
      this.#unidentifiedFinding(target, subject, selector, origin, code.length),
    ]);
  }

  /**
   * The counterparty is an EIP-7702 account.
   *
   * Recorded at `info`, so it appears in the evidence without moving the tier
   * on its own. The reasoning is R2's: a property shared by a large and
   * growing population of ordinary accounts cannot by itself be a reason to
   * refuse a transaction, or the verdict becomes noise the caller learns to
   * click past. What can move the tier is what the delegate turns out to be,
   * and that is judged by the same rules as any other counterparty — which is
   * how a wallet freshly re-delegated to a contract nobody has ever seen, the
   * shape of a 7702 hijack, reaches `high` on its own merits.
   */
  #delegationFinding(account: Address, delegate: Address): Finding {
    return {
      ruleId: this.id,
      severity: "info",
      standing: true,
      title: "Counterparty is an EIP-7702 delegated account",
      detail:
        `${account} is an account, not a contract. Its code is an EIP-7702 delegation ` +
        `to ${delegate}, which is where the logic this call runs actually lives. The ` +
        "account holder can point that delegation somewhere else with a single signed " +
        "authorisation — no proxy admin, no timelock — so what runs here is only as " +
        "stable as their key.",
      evidence: {
        account,
        delegate,
        standard: "EIP-7702",
        derived_from: "fork_state",
      },
    };
  }

  /**
   * Calldata sent to an address that holds no code.
   *
   * The EVM does not fault here: the call succeeds, returns nothing, and the
   * agent's own success check passes. Something has gone wrong that no rule
   * reading protocol data would ever notice — a mistyped or truncated address,
   * an address for the wrong chain, or a contract that has since
   * self-destructed. A bare value transfer to an account with no code is an
   * ordinary payment and gets no finding.
   */
  #findingsForCodelessTarget(target: Address, selector: Hex | null): Finding[] {
    if (selector === null) return [];
    return [
      {
        ruleId: this.id,
        severity: "warning",
        standing: false,
        title: "Call data sent to an address with no code",
        detail:
          `${target} holds no code at the simulated block, but this transaction carries ` +
          `calldata beginning ${selector}. The call will not revert and will not do ` +
          "anything either: an address that cannot execute silently accepts any call. " +
          "This is usually a wrong address or a contract that no longer exists.",
        evidence: {
          counterparty: target,
          selector,
          counterparty_code_size_bytes: 0,
          derived_from: "fork_state",
        },
      },
    ];
  }

  #unidentifiedFinding(
    target: Address,
    subject: Address,
    selector: Hex | null,
    origin: ContractOrigin,
    codeHexLength: number,
  ): Finding {
    const age = this.#describeAge(origin);
    const conventional =
      selector === null ? undefined : CONVENTIONAL_SELECTORS[selector];

    const selectorNote =
      selector === null
        ? "The transaction carries no calldata."
        : conventional === undefined
          ? `Its calldata begins ${selector}, a selector this rule cannot interpret without an ABI.`
          : `Its calldata begins ${selector}, which matches ${conventional} by convention only — ` +
            "on a contract nobody has identified, a familiar selector is a claim the code " +
            "makes about itself, not evidence about what it does.";

    const delegated = subject !== target;
    const subjectPhrase = delegated
      ? `${subject}, the contract ${target} delegates to,`
      : `${target},`;

    return {
      ruleId: this.id,
      /*
       * An age that could not be established is `warning`, not `info`. It used
       * to be `info`, so an RPC timeout on the age search turned an unindexed
       * contract deployed an hour ago from `high` into `low` — the absence of
       * evidence read as evidence of age.
       */
      severity: age.fresh
        ? "critical"
        : origin.status === "indeterminate"
          ? "warning"
          : "info",
      // True of every call to this counterparty, not of this one in
      // particular. Uncapped by policy all the same; see the file header.
      standing: true,
      title: age.fresh
        ? `Unidentified ${delegated ? "delegate" : "contract"}, deployed ${age.short}`
        : origin.status === "indeterminate"
          ? `Unidentified ${delegated ? "delegate" : "contract"} of unknown age`
          : `Counterparty${delegated ? "'s delegate" : ""} is not indexed by any known deployment`,
      detail:
        `No deployment in the subgraph registry indexes ${subjectPhrase} so nothing ` +
        `independent describes what this contract is. ${age.sentence} ${selectorNote}`,
      evidence: {
        counterparty: target,
        // Named separately because the age and the registry answer are about
        // this address, and a reader checking them against an explorer needs
        // to know which one to look up.
        identified_subject: subject,
        delegated,
        indexing_deployments: 0,
        /*
          * Read `origin_block` through `age_bound`, which is why they sit
          * together. For `deployed` it is the block the code appeared in, and
          * a reader can look it up and see the creation. For `older_than` it
          * is the oldest block the search checked and found code at — a bound
          * the search paid for, nothing more. Calling that one a deployment
          * block would send anyone verifying the claim to a block where
          * nothing happened.
          */
        age_bound: origin.status,
        origin_block: origin.status === "indeterminate" ? null : origin.block,
        origin_at:
          origin.status === "indeterminate"
            ? null
            : new Date(origin.timestamp * 1000).toISOString(),
        age_seconds: age.seconds,
        fresh_deployment_threshold_seconds: this.#freshSeconds,
        selector,
        selector_convention: conventional ?? null,
        // The counterparty's own code, which for a delegated account is the
        // twenty-three byte indicator rather than the delegate's program.
        // Named for the address it describes: an unqualified "code size" next
        // to two addresses invites the reader to check the wrong one.
        counterparty_code_size_bytes: Math.floor((codeHexLength - 2) / 2),
        derived_from: "subgraph_registry+rpc_code_history",
      },
    };
  }

  /**
   * Turn an origin into the two things the finding needs: whether it is inside
   * the suspicion window, and a sentence a reader can act on.
   *
   * An indeterminate age is deliberately not treated as old. It is also not
   * treated as fresh — inventing a `high` verdict out of an RPC timeout would
   * be the mirror of the fail-open this rule was written to close. The finding
   * is `warning`, which puts the transaction in front of a human.
   */
  #describeAge(origin: ContractOrigin): {
    readonly fresh: boolean;
    readonly short: string;
    readonly sentence: string;
    readonly seconds: number | null;
  } {
    if (origin.status === "indeterminate") {
      return {
        fresh: false,
        short: "at an unknown time",
        sentence:
          `Its age could not be established (${origin.reason}), so how long it has ` +
          "existed is unknown rather than long.",
        seconds: null,
      };
    }

    const seconds = Math.max(
      0,
      Math.round(this.#now().getTime() / 1000 - origin.timestamp),
    );
    const short = `${humanDuration(seconds)} ago`;

    if (origin.status === "older_than") {
      return {
        fresh: false,
        short,
        sentence:
          `Code has existed at the address since at least block ${origin.block}, ` +
          `${short}, so it is not a fresh deployment.`,
        seconds,
      };
    }

    return {
      fresh: seconds < this.#freshSeconds,
      short,
      sentence:
        `Code first appeared at the address in block ${origin.block}, ${short}. ` +
        (seconds < this.#freshSeconds
          ? "A contract this new that nobody indexes has had no time to acquire any " +
            "public record at all, which is the shape of a contract deployed for one " +
            "transaction."
          : "It is old enough that its absence from every registry is a gap in coverage " +
            "rather than a sign of a fresh deployment."),
      seconds,
    };
  }
}
