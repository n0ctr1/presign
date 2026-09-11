import assert from "node:assert/strict";
import { test } from "node:test";

import { parseTransaction, recoverTransactionAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { commitTransaction } from "@presign/hedera";

import {
  APPROVAL_NONCE,
  commitmentOf,
  DEFAULT_BROKER_POLICY,
  signThroughVerdict,
} from "../dist/index.js";
import type { AssessedTransaction, BrokerOptions, BrokerPolicy, HumanApprover } from "../dist/index.js";

const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const ATTACKER = "0x2222222222222222222222222222222222222222";
const FRIEND = "0x3333333333333333333333333333333333333333";
const SALT = "0123456789abcdef0123456789abcdef";

// Fresh keys per run, never written anywhere.
const agent = privateKeyToAccount(generatePrivateKey());
const ledger = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());

const FIELDS = { nonce: 7, gas: 60_000n, maxFeePerGas: 30_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };
const chain = { fill: () => Promise.resolve(FIELDS) };

const request = { to: USDC as `0x${string}`, value: 0n, data: "0x095ea7b3" as `0x${string}`, chainId: 1 };
const QUIET = { observed: true, ethOutWei: "0", ethRecipients: [], tokensOut: [] };

interface Setup {
  tier: string;
  approver?: HumanApprover | null;
  effects?: object;
  policy?: Partial<BrokerPolicy>;
  session?: { ethSpentWei: bigint };
  seen?: AssessedTransaction[];
  tamper?: boolean;
}

function options(setup: Setup): BrokerOptions {
  return {
    account: agent,
    chain,
    approver: setup.approver ?? null,
    policy: { ...DEFAULT_BROKER_POLICY, ...setup.policy },
    session: setup.session ?? { ethSpentWei: 0n },
    buyVerdict: (transaction) => {
      setup.seen?.push(transaction);
      const bound = setup.tamper ? { ...transaction, value: transaction.value + 1n } : transaction;
      return Promise.resolve({
        ok: true,
        tier: setup.tier,
        result: {
          verdict: { tier: setup.tier, findings: [], provenance: { chainId: 1 }, effects: setup.effects ?? QUIET },
          journal: { tx_commitment: commitmentOf(bound, SALT), salt: SALT },
        },
      });
    },
  };
}

/** A device double that signs the requested bytes with a given key. */
function device(
  signer: typeof ledger,
  behaviour: { clearSigned?: boolean; decline?: boolean } = {},
): HumanApprover & { asked: { nonce: number }[] } {
  const approver = {
    address: ledger.address,
    asked: [] as { nonce: number }[],
    async request(signable: Parameters<HumanApprover["request"]>[0]) {
      approver.asked.push({ nonce: signable.nonce });
      if (behaviour.decline) return { approved: false as const, reason: "rejected_on_device", detail: "6985" };
      const raw = await signer.signTransaction({
        type: "eip1559",
        chainId: signable.chainId,
        nonce: signable.nonce,
        to: signable.to ?? undefined,
        value: signable.value,
        data: signable.data,
        gas: signable.gasLimit,
        maxFeePerGas: signable.maxFeePerGas,
        maxPriorityFeePerGas: signable.maxPriorityFeePerGas,
      });
      const parsed = parseTransaction(raw);
      return {
        approved: true as const,
        signature: { r: parsed.r!, s: parsed.s!, v: parsed.yParity! },
        clearSigned: behaviour.clearSigned ?? true,
      };
    },
  };
  return approver;
}

const signerOf = (raw: unknown) => recoverTransactionAddress({ serializedTransaction: raw as never });

test("the broker's commitment is the journal's, byte for byte", () => {
  const transaction = { from: agent.address, to: USDC, value: 5n, data: "0xABCD", chainId: 1 } as AssessedTransaction;
  assert.equal(commitmentOf(transaction, SALT), commitTransaction(transaction as never, SALT));
});

test("a low verdict that moves nothing is signed, as the broker's own account", async () => {
  const seen: AssessedTransaction[] = [];
  const out = await signThroughVerdict(options({ tier: "low", seen }), request);

  assert.equal(out["decision"], "signed");
  assert.equal(await signerOf(out["raw_transaction"]), agent.address);
  assert.equal(seen[0]?.from, agent.address);
  assert.equal(parseTransaction(out["raw_transaction"] as never).nonce, FIELDS.nonce);
});

test("ETH to a stranger is not signed on a low verdict alone", async () => {
  // The rules find nothing wrong with paying someone. A compromised agent
  // draining the wallet looks exactly like that.
  const effects = { observed: true, ethOutWei: "5000000000000000", ethRecipients: [ATTACKER], tokensOut: [] };
  const out = await signThroughVerdict(options({ tier: "low", effects }), { ...request, to: ATTACKER as never, value: 5n * 10n ** 15n, data: "0x" as never });

  assert.equal(out["decision"], "escalation_required");
  assert.equal(out["raw_transaction"], undefined);
  assert.match(String((out["policy_reasons"] as string[])[0]), /outside the allowlist/);
});

test("the same transfer to an allowlisted recipient under the ceiling is signed", async () => {
  const effects = { observed: true, ethOutWei: "5000000000000000", ethRecipients: [FRIEND], tokensOut: [] };
  const out = await signThroughVerdict(
    options({ tier: "low", effects, policy: { allowedRecipients: new Set([FRIEND]) } }),
    { ...request, to: FRIEND as never, value: 5n * 10n ** 15n, data: "0x" as never },
  );

  assert.equal(out["decision"], "signed");
});

test("tokens to a stranger are escalated, and signed only after the human approves", async () => {
  const effects = {
    observed: true,
    ethOutWei: "0",
    ethRecipients: [],
    tokensOut: [{ token: USDC, amountOut: "1000000", recipients: [ATTACKER], burned: false, unidentifiedRecipient: false }],
  };
  const approver = device(ledger);
  const out = await signThroughVerdict(options({ tier: "low", effects, approver }), request);

  assert.equal(out["decision"], "signed_after_human_approval");
  assert.equal(approver.asked.length, 1);
});

test("effects the simulation could not read are escalated, never waved through", async () => {
  const out = await signThroughVerdict(options({ tier: "low", effects: { observed: false } }), request);
  assert.equal(out["decision"], "escalation_required");
});

test("ETH past the session ceiling is refused outright", async () => {
  const effects = { observed: true, ethOutWei: "5000000000000000", ethRecipients: [FRIEND], tokensOut: [] };
  const session = { ethSpentWei: 0n };
  const setup = { tier: "low", effects, session, policy: { allowedRecipients: new Set([FRIEND]), maxEthPerSessionWei: 8n * 10n ** 15n } };

  assert.equal((await signThroughVerdict(options(setup), request))["decision"], "signed");
  const second = await signThroughVerdict(options(setup), request);
  assert.equal(second["decision"], "refused");
  assert.equal(second["reason"], "session_value_ceiling");
});

test("a fee past its ceiling is refused before a verdict is bought", async () => {
  const seen: AssessedTransaction[] = [];
  const out = await signThroughVerdict(
    { ...options({ tier: "low", seen }), chain: { fill: () => Promise.resolve({ ...FIELDS, maxPriorityFeePerGas: 10n ** 12n }) } },
    request,
  );

  assert.equal(out["reason"], "fee_above_ceiling");
  assert.equal(seen.length, 0);
});

test("a verdict about a different transaction is not a verdict about this one", async () => {
  const out = await signThroughVerdict(options({ tier: "low", tamper: true }), request);

  assert.equal(out["decision"], "refused");
  assert.equal(out["reason"], "verdict_not_bound");
});

test("high and unavailable are refused and never reach the device", async () => {
  for (const tier of ["high", "unavailable"]) {
    const approver = device(ledger);
    const out = await signThroughVerdict(options({ tier, approver }), request);

    assert.equal(out["decision"], "refused");
    assert.equal(out["raw_transaction"], undefined);
    assert.equal(approver.asked.length, 0);
  }
});

test("medium without a device is not signed", async () => {
  const out = await signThroughVerdict(options({ tier: "medium" }), request);

  assert.equal(out["decision"], "escalation_required");
  assert.equal(out["raw_transaction"], undefined);
});

test("the device approves with a nonce no account reaches, and the agent signs with the real one", async () => {
  const approver = device(ledger);
  const out = await signThroughVerdict(options({ tier: "medium", approver }), request);

  assert.equal(out["decision"], "signed_after_human_approval");
  // The approval is a real signature from the Ledger account; with the agent's
  // nonce it would have been a transaction that account could be made to send.
  assert.equal(approver.asked[0]?.nonce, APPROVAL_NONCE);
  const raw = parseTransaction(out["raw_transaction"] as never);
  assert.equal(raw.nonce, FIELDS.nonce);
  assert.equal(await signerOf(out["raw_transaction"]), agent.address);
  assert.ok(!JSON.stringify(out).includes("\"r\""));
});

test("a signature from a different key is not an approval", async () => {
  const out = await signThroughVerdict(options({ tier: "medium", approver: device(stranger) }), request);

  assert.equal(out["decision"], "refused");
  assert.equal(out["reason"], "approval_not_verified");
});

test("a blind-signed hash is not an approval of the transaction", async () => {
  const out = await signThroughVerdict(options({ tier: "medium", approver: device(ledger, { clearSigned: false }) }), request);
  assert.equal(out["reason"], "blind_signed");
});

test("a human's no is reported as a decision, and nothing is signed", async () => {
  const out = await signThroughVerdict(options({ tier: "medium", approver: device(ledger, { decline: true }) }), request);

  assert.equal(out["decision"], "declined_by_human");
  assert.equal(out["raw_transaction"], undefined);
});

test("no verdict means no signature", async () => {
  const out = await signThroughVerdict(
    { ...options({ tier: "low" }), buyVerdict: () => Promise.resolve({ ok: false, result: { error: "session_budget_exceeded" } }) },
    request,
  );

  assert.equal(out["decision"], "refused");
  assert.equal(out["error"], "session_budget_exceeded");
});
