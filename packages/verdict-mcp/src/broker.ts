/**
 * A signing broker that only signs through a verdict, and through a policy.
 *
 * presign the service is an advisor: it never holds a key. That leaves the
 * obvious question open — an agent that has been compromised or talked into
 * something simply does not ask. This module closes it on the agent's side.
 * The key lives here, sealed in the Ledger Key Ring, and the model is given a
 * tool that asks for a signature, never the key.
 *
 * A verdict alone is not enough to sign on. The rules look for known risks —
 * an unlimited approval, replaceable code, broken accounting, a contract
 * nobody knows — and a plain transfer of the whole balance to an attacker
 * trips none of them. It comes back `low`, which is right for an advisor and
 * wrong for a signer. So the broker also reads what the transaction moves out
 * of the wallet, from the verdict's simulated effects, and applies a policy of
 * its own:
 *
 *   value to a recipient outside the allowlist   a human approves it
 *   ETH above the per-transaction ceiling         a human approves it
 *   effects the simulation could not read         a human approves it
 *   ETH past the session ceiling                  refused
 *   a fee past its ceiling                        refused, before paying for a verdict
 *
 * and then the verdict decides the rest:
 *
 *   low          signed with the agent's key
 *   medium       signed only after the Ledger signs the same call, with the
 *                human looking at the decoded transaction
 *   high         refused, and the device is never asked
 *   unavailable  refused, for the same reason
 *
 * The model supplies `to`, `value`, `data` and `chainId`. Sender, nonce, gas
 * and fees are the broker's: a model that could set the fee could hand the
 * balance to a block builder, and one that could set the nonce could collect
 * signatures to broadcast after the world has changed.
 */

import { createHash } from "node:crypto";

import {
  keccak256,
  recoverTransactionAddress,
  serializeTransaction,
  type Address,
  type Hex,
  type TransactionSerializableEIP1559,
} from "viem";

/** The fields a risk verdict judges. */
export interface AssessedTransaction {
  readonly from: Address;
  readonly to: Address | null;
  readonly value: bigint;
  readonly data: Hex;
  readonly chainId: number;
}

/** What a signature additionally commits to. */
export interface SignatureFields {
  readonly nonce: number;
  readonly gas: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
}

/** The agent's key, as viem's local account exposes it. */
export interface BrokerAccount {
  readonly address: Address;
  signTransaction(transaction: TransactionSerializableEIP1559): Promise<Hex>;
}

/** Nonce, gas and fees for the agent's account, from the chain and nowhere else. */
export interface ChainReader {
  fill(transaction: AssessedTransaction): Promise<SignatureFields>;
}

/** A human with a device, when one is attached. */
export interface HumanApprover {
  /** The device's address at the path it signs with. */
  readonly address: Address;
  request(
    signable: AssessedTransaction & {
      readonly nonce: number;
      readonly gasLimit: bigint;
      readonly maxFeePerGas: bigint;
      readonly maxPriorityFeePerGas: bigint;
    },
    verdict: unknown,
  ): Promise<
    | {
        readonly approved: true;
        readonly signature: { readonly r: Hex; readonly s: Hex; readonly v: number };
        readonly clearSigned: boolean;
      }
    | { readonly approved: false; readonly reason: string; readonly detail: string }
  >;
}

/** A verdict bought from the service, or the reason none was obtained. */
export type VerdictPurchase =
  | { readonly ok: true; readonly tier: string; readonly result: Record<string, unknown> }
  | { readonly ok: false; readonly result: Record<string, unknown> };

export interface BrokerPolicy {
  /** Recipients value may reach without a human, lowercase. Empty by default. */
  readonly allowedRecipients: ReadonlySet<string>;
  /** ETH out of one transaction above which a human approves, in wei. */
  readonly maxEthPerTransactionWei: bigint;
  /** ETH out across the session past which nothing more is signed, in wei. */
  readonly maxEthPerSessionWei: bigint;
  /** Ceiling on `gas × maxFeePerGas`, in wei. */
  readonly maxFeeWei: bigint;
  /** Ceiling on the priority fee, in wei per gas. */
  readonly maxPriorityFeePerGasWei: bigint;
}

export const DEFAULT_BROKER_POLICY: BrokerPolicy = {
  allowedRecipients: new Set(),
  maxEthPerTransactionWei: 10n ** 16n, // 0.01 ETH
  maxEthPerSessionWei: 5n * 10n ** 16n, // 0.05 ETH
  maxFeeWei: 5n * 10n ** 15n, // 0.005 ETH
  maxPriorityFeePerGasWei: 3n * 10n ** 9n, // 3 gwei
};

/** What the broker has already let out of the wallet in this session. */
export interface BrokerSession {
  ethSpentWei: bigint;
}

export interface BrokerOptions {
  readonly account: BrokerAccount;
  readonly chain: ChainReader;
  readonly buyVerdict: (transaction: AssessedTransaction) => Promise<VerdictPurchase>;
  readonly approver: HumanApprover | null;
  readonly policy: BrokerPolicy;
  readonly session: BrokerSession;
}

export interface SignRequest {
  readonly to: Address | null;
  readonly value: bigint;
  readonly data: Hex;
  readonly chainId: number;
}

/**
 * The nonce the device signs its approval with.
 *
 * The approval is a real signature over a real transaction from the Ledger
 * account — that is what makes the device show the decoded call. Signed with
 * the agent's nonce it was a valid transaction the Ledger account could be
 * made to send, if the signature ever leaked. No account reaches this nonce,
 * so the approval can never be included in a block.
 */
export const APPROVAL_NONCE = Number.MAX_SAFE_INTEGER;

/** The journal's commitment to a transaction, recomputed here to bind the verdict to it. */
export function commitmentOf(transaction: AssessedTransaction, salt: string): string {
  const canonical = [
    transaction.from.toLowerCase(),
    (transaction.to ?? "").toLowerCase(),
    transaction.value.toString(10),
    transaction.data.toLowerCase(),
    String(transaction.chainId),
  ].join("|");
  const hash = createHash("sha256").update(canonical, "utf8").digest("hex");
  return createHash("sha256").update(`${salt}|${hash}`, "utf8").digest("hex");
}

const NOT_SIGNED = "No signature was produced. Do not try to obtain one another way.";

interface Effects {
  readonly observed?: boolean;
  readonly ethOutWei?: string;
  readonly ethRecipients?: readonly string[];
  readonly tokensOut?: readonly {
    readonly token: string;
    readonly amountOut: string;
    readonly recipients: readonly string[];
    readonly burned: boolean;
    readonly unidentifiedRecipient: boolean;
  }[];
}

/** Why the policy wants a human, and the ETH this transaction sends. */
function applyPolicy(
  effects: Effects | undefined,
  policy: BrokerPolicy,
): { readonly reasons: readonly string[]; readonly ethOut: bigint } {
  if (effects?.observed !== true) {
    return {
      reasons: ["the simulation could not show what this transaction moves out of the wallet"],
      ethOut: 0n,
    };
  }

  const reasons: string[] = [];
  const allowed = (address: string) => policy.allowedRecipients.has(address.toLowerCase());

  const ethOut = BigInt(effects.ethOutWei ?? "0");
  if (ethOut > 0n) {
    const recipients = effects.ethRecipients ?? [];
    if (recipients.length === 0 || !recipients.every(allowed)) {
      reasons.push(`sends ${ethOut} wei to ${recipients.join(", ") || "an address it could not name"}, outside the allowlist`);
    }
    if (ethOut > policy.maxEthPerTransactionWei) {
      reasons.push(`sends ${ethOut} wei, above the ${policy.maxEthPerTransactionWei} wei per-transaction ceiling`);
    }
  }

  for (const token of effects.tokensOut ?? []) {
    if (token.burned) continue;
    if (token.unidentifiedRecipient || !token.recipients.every(allowed)) {
      reasons.push(
        `moves ${token.amountOut} units of ${token.token} to ` +
          `${token.recipients.join(", ") || "an address it could not name"}, outside the allowlist`,
      );
    }
  }

  return { reasons, ethOut };
}

export async function signThroughVerdict(
  options: BrokerOptions,
  request: SignRequest,
): Promise<Record<string, unknown>> {
  const { policy, session } = options;
  // The sender is the broker's own account, never a value the model supplies:
  // a verdict about a different sender is a verdict about a different
  // transaction.
  const assessed: AssessedTransaction = {
    from: options.account.address,
    to: request.to,
    value: request.value,
    data: request.data,
    chainId: request.chainId,
  };

  let fields: SignatureFields;
  try {
    fields = await options.chain.fill(assessed);
  } catch (error) {
    return {
      decision: "not_signed",
      reason: "could_not_prepare",
      detail: error instanceof Error ? error.message : String(error),
      what_to_do: NOT_SIGNED,
    };
  }

  // Before paying for a verdict: a fee past its ceiling is refused whatever
  // the verdict would say.
  if (fields.maxPriorityFeePerGas > policy.maxPriorityFeePerGasWei || fields.gas * fields.maxFeePerGas > policy.maxFeeWei) {
    return {
      decision: "refused",
      reason: "fee_above_ceiling",
      detail:
        `gas ${fields.gas} × max fee ${fields.maxFeePerGas} wei, priority ${fields.maxPriorityFeePerGas} wei; ` +
        `ceilings are ${policy.maxFeeWei} wei in total and ${policy.maxPriorityFeePerGasWei} wei priority`,
      what_to_do: NOT_SIGNED,
    };
  }

  const purchase = await options.buyVerdict(assessed);
  if (!purchase.ok) {
    return { decision: "refused", reason: "no_verdict", ...purchase.result, what_to_do: NOT_SIGNED };
  }
  const result = purchase.result;
  const verdict = result["verdict"] as
    | { tier?: string; provenance?: { chainId?: number }; effects?: Effects }
    | undefined;

  /*
   * The verdict must be about this transaction. The response carries the
   * journal's commitment and its salt; recomputing it here means a response
   * for a different transaction — a stale cache, a proxy, a substituted
   * service — cannot become a signature.
   */
  const journal = result["journal"] as { tx_commitment?: string; salt?: string } | undefined;
  if (
    typeof journal?.salt !== "string" ||
    journal.tx_commitment !== commitmentOf(assessed, journal.salt) ||
    verdict?.provenance?.chainId !== assessed.chainId
  ) {
    return {
      decision: "refused",
      reason: "verdict_not_bound",
      detail: "the verdict's commitment does not match this transaction, so it is not a verdict about it",
      what_to_do: NOT_SIGNED,
    };
  }

  const { reasons, ethOut } = applyPolicy(verdict.effects, policy);
  if (session.ethSpentWei + ethOut > policy.maxEthPerSessionWei) {
    return {
      decision: "refused",
      reason: "session_value_ceiling",
      detail: `this session has sent ${session.ethSpentWei} wei; ${ethOut} more would pass the ${policy.maxEthPerSessionWei} wei ceiling`,
      verdict: result,
      what_to_do: NOT_SIGNED,
    };
  }

  // The policy can only raise the tier. A `low` verdict that moves value to a
  // stranger is escalated; nothing makes a `high` one signable.
  const tier = purchase.tier === "low" && reasons.length > 0 ? "medium" : purchase.tier;

  const unsigned: TransactionSerializableEIP1559 = {
    type: "eip1559",
    chainId: assessed.chainId,
    nonce: fields.nonce,
    ...(assessed.to === null ? {} : { to: assessed.to }),
    value: assessed.value,
    data: assessed.data,
    gas: fields.gas,
    maxFeePerGas: fields.maxFeePerGas,
    maxPriorityFeePerGas: fields.maxPriorityFeePerGas,
  };
  const prepared = {
    signed_as: assessed.from,
    nonce: fields.nonce,
    gas: fields.gas.toString(),
    max_fee_per_gas: fields.maxFeePerGas.toString(),
    max_priority_fee_per_gas: fields.maxPriorityFeePerGas.toString(),
    verdict_tier: purchase.tier,
    policy_reasons: reasons,
  };

  if (tier === "low") {
    const raw = await options.account.signTransaction(unsigned);
    session.ethSpentWei += ethOut;
    return {
      decision: "signed",
      tier,
      raw_transaction: raw,
      transaction_hash: keccak256(raw),
      ...prepared,
      verdict: result,
      what_to_do: "Signed. Broadcasting it is your decision; this server never broadcasts.",
    };
  }

  if (tier === "medium") {
    if (options.approver === null) {
      return {
        decision: "escalation_required",
        tier,
        ...prepared,
        verdict: result,
        what_to_do:
          `${NOT_SIGNED} A human must approve this on a Ledger, and no device is attached to this server.`,
      };
    }

    const approver = options.approver;
    const approval: TransactionSerializableEIP1559 = { ...unsigned, nonce: APPROVAL_NONCE };
    const answer = await approver.request(
      {
        ...assessed,
        nonce: APPROVAL_NONCE,
        gasLimit: fields.gas,
        maxFeePerGas: fields.maxFeePerGas,
        maxPriorityFeePerGas: fields.maxPriorityFeePerGas,
      },
      verdict,
    );

    if (!answer.approved) {
      return {
        decision: answer.reason === "rejected_on_device" ? "declined_by_human" : "escalation_failed",
        tier,
        reason: answer.reason,
        detail: answer.detail,
        ...prepared,
        verdict: result,
        what_to_do: NOT_SIGNED,
      };
    }

    if (!answer.clearSigned) {
      return {
        decision: "refused",
        tier,
        reason: "blind_signed",
        detail:
          "The device fell back to blind signing, so the human approved a hash rather than " +
          "the decoded transaction. That is not an approval of this transaction.",
        ...prepared,
        verdict: result,
        what_to_do: NOT_SIGNED,
      };
    }

    const { r, s, v } = answer.signature;
    const signedApproval = serializeTransaction(approval, { r, s, yParity: v >= 27 ? v - 27 : v });
    const recovered = await recoverTransactionAddress({ serializedTransaction: signedApproval });
    if (recovered.toLowerCase() !== approver.address.toLowerCase()) {
      return {
        decision: "refused",
        tier,
        reason: "approval_not_verified",
        detail:
          `The device signature recovers to ${recovered}, not to the device address ` +
          `${approver.address}, so it does not prove this device approved this call.`,
        ...prepared,
        verdict: result,
        what_to_do: NOT_SIGNED,
      };
    }

    const raw = await options.account.signTransaction(unsigned);
    session.ethSpentWei += ethOut;
    return {
      decision: "signed_after_human_approval",
      tier,
      raw_transaction: raw,
      transaction_hash: keccak256(raw),
      ...prepared,
      human_approval: {
        device_address: approver.address,
        clear_signed: true,
        // Proof the approval existed, without the approval itself.
        approval_commitment: keccak256(signedApproval),
      },
      verdict: result,
      what_to_do: "Signed after the human approved it on the device. Broadcasting it is your decision.",
    };
  }

  return {
    decision: "refused",
    tier,
    reason: tier === "high" ? "high_risk" : tier === "unavailable" ? "unavailable" : "unrecognised_tier",
    ...prepared,
    verdict: result,
    what_to_do:
      tier === "unavailable"
        ? `${NOT_SIGNED} The transaction could not be evaluated, which is not the same as safe.`
        : NOT_SIGNED,
  };
}
