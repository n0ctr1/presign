import assert from "node:assert/strict";
import { test } from "node:test";

import {
  allowanceSlot,
  calldataAddresses,
  MAX_ADDRESS_CANDIDATES,
  UnlimitedApprovalRule,
} from "../../dist/index.js";
import type { StateDiff, UnsignedTransaction } from "../../dist/index.js";

const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const OWNER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const SPENDER = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
const MAX = `0x${"f".repeat(64)}`;

/** USDC's allowance mapping position, recovered by search against mainnet. */
const USDC_ALLOWANCE_MAPPING_SLOT = 10;

const approveCalldata = (spender: string, amountHex: string) =>
  `0x095ea7b3${spender.slice(2).padStart(64, "0")}${amountHex}`;

function transaction(overrides: Partial<UnsignedTransaction> = {}) {
  return {
    from: OWNER,
    to: USDC,
    value: 0n,
    data: approveCalldata(SPENDER, "f".repeat(64)),
    chainId: 1,
    ...overrides,
  } as UnsignedTransaction;
}

function diffWriting(slot: string, value: string, token = USDC): StateDiff {
  return {
    pre: {},
    post: { [token]: { storage: { [slot]: value } } },
    blockNumber: 25916120,
    revertReason: null,
  } as unknown as StateDiff;
}

/** Rules return an outcome; these tests are about the findings inside it. */
async function findingsOf(rule: { evaluate: (c: never) => Promise<unknown> }, ctx: never) {
  const outcome = (await rule.evaluate(ctx)) as {
    status: string;
    findings?: readonly { severity: string; ruleId: string; title: string; evidence: Record<string, unknown> }[];
  };
  assert.equal(outcome.status, "evaluated");
  return outcome.findings ?? [];
}

type Call = (address: string, data: string) => Promise<string | null>;

const context = (
  tx: UnsignedTransaction,
  diff: StateDiff,
  call: Call = () => Promise.resolve(null),
  extra: object = {},
) =>
  ({
    transaction: tx,
    diff,
    getStorageAt: () => Promise.reject(new Error("unused")),
    getCode: () => Promise.reject(new Error("unused")),
    call,
    ...extra,
  }) as never;

const uint = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;

/** A token at the forked block answering the reads R1 makes, or reverting. */
const token = (answers: { totalSupply?: bigint; balance?: bigint; operator?: boolean }): Call =>
  (_address, data) => {
    if (data === "0x18160ddd") return Promise.resolve(answers.totalSupply === undefined ? null : uint(answers.totalSupply));
    if (data.startsWith("0x70a08231")) return Promise.resolve(answers.balance === undefined ? null : uint(answers.balance));
    if (data.startsWith("0xe985e9c5")) return Promise.resolve(answers.operator === true ? uint(0n) : null);
    return Promise.resolve(null);
  };

const FLAGGED = "0x43412801d29861ecc4c4d86e5becfd16af86a67b";
const USDC_SUPPLY = 50_000_000_000n * 10n ** 6n;

test("reproduces USDC's real allowance slot from the mapping layout", () => {
  // Confirmed on mainnet: this is the slot the tracer reported for this pair.
  assert.equal(
    allowanceSlot(OWNER, SPENDER, USDC_ALLOWANCE_MAPPING_SLOT).toLowerCase(),
    "0x9364ceadd85b1a5e37140ae24b0208a2ddc63c5e08ed1e4feae224ac4edf5e8e",
  );
});

test("pulls address-shaped words out of calldata and skips the rest", () => {
  // The amount word is all-ff, so it is not address-shaped and must not be
  // mistaken for a spender.
  assert.deepEqual(calldataAddresses(approveCalldata(SPENDER, "f".repeat(64)) as never), [SPENDER]);

  // Scanning every byte offset reads a small amount's zero padding as
  // `0x…03e8`. Nobody can deploy at an address that empty, so it is dropped.
  assert.deepEqual(calldataAddresses(approveCalldata(SPENDER, uint(1000n).slice(2)) as never), [SPENDER]);
});

test("an approval nested inside an account's execute call is found", async () => {
  // A 7702-delegated wallet calling itself: execute(USDC, 0, approve(spender, max)).
  // The spender sits four bytes off every outer word boundary, is not the
  // target, and its own state does not change.
  const arg = (address: string) => address.slice(2).padStart(64, "0");
  const inner = `095ea7b3${arg(SPENDER)}${"f".repeat(64)}`;
  const data = `0xb61d27f6${arg(USDC)}${"0".repeat(64)}${arg("0x60")}${arg("0x44")}${inner}${"0".repeat(56)}`;
  const slot = allowanceSlot(OWNER, SPENDER, USDC_ALLOWANCE_MAPPING_SLOT);

  const findings = await findingsOf(
    new UnlimitedApprovalRule(),
    context(transaction({ to: OWNER, data: data as never }), diffWriting(slot, MAX)),
  );

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.evidence["spender"], SPENDER);
});

test("2^127 is at least the token's supply, and is unlimited like max", async () => {
  const slot = allowanceSlot(OWNER, SPENDER, USDC_ALLOWANCE_MAPPING_SLOT);
  const findings = await findingsOf(
    new UnlimitedApprovalRule(),
    context(transaction(), diffWriting(slot, uint(2n ** 127n)), token({ totalSupply: USDC_SUPPLY, balance: 0n })),
  );

  // A fixed bar is a number to stay under. The token's own supply is not:
  // no balance can ever exhaust an allowance that large.
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.severity, "warning");
  assert.equal(findings[0]?.evidence["unlimited_basis"], "at_least_total_supply");
  assert.match(String(findings[0]?.title), /^Unlimited token approval/);
});

test("an approval covering the owner's whole balance is reported", async () => {
  const slot = allowanceSlot(OWNER, SPENDER, USDC_ALLOWANCE_MAPPING_SLOT);
  const findings = await findingsOf(
    new UnlimitedApprovalRule(),
    context(
      transaction(),
      diffWriting(slot, uint(1000n * 10n ** 6n)),
      token({ totalSupply: USDC_SUPPLY, balance: 400n * 10n ** 6n }),
    ),
  );

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.evidence["unlimited_basis"], "covers_balance");
  assert.equal(findings[0]?.evidence["owner_balance"], "400000000");
  assert.match(String(findings[0]?.title), /entire token balance/);
});

test("an approval below both the balance and the supply is a budget", async () => {
  const slot = allowanceSlot(OWNER, SPENDER, USDC_ALLOWANCE_MAPPING_SLOT);
  assert.deepEqual(
    await findingsOf(
      new UnlimitedApprovalRule(),
      context(
        transaction(),
        diffWriting(slot, uint(1000n * 10n ** 6n)),
        token({ totalSupply: USDC_SUPPLY, balance: 5000n * 10n ** 6n }),
      ),
    ),
    [],
  );
});

test("a node failing while the token is read is not taken for a budget", async () => {
  const slot = allowanceSlot(OWNER, SPENDER, USDC_ALLOWANCE_MAPPING_SLOT);
  // Null would mean "no supply to compare against" and let 2^127 through.
  // The engine reports a throwing rule as unavailable.
  await assert.rejects(
    new UnlimitedApprovalRule().evaluate(
      context(transaction(), diffWriting(slot, uint(2n ** 127n)), () => Promise.reject(new Error("timeout"))),
    ),
    /timeout/,
  );
});

test("setApprovalForAll is reported as an operator over the whole collection", async () => {
  const COLLECTION = "0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d";
  const slot = allowanceSlot(OWNER, SPENDER, 5);
  const setApprovalForAll = `0xa22cb465${SPENDER.slice(2).padStart(64, "0")}${uint(1n).slice(2)}`;
  const tx = transaction({ to: COLLECTION, data: setApprovalForAll as never });

  const findings = await findingsOf(
    new UnlimitedApprovalRule(),
    context(tx, diffWriting(slot, uint(1n), COLLECTION), token({ operator: true })),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.severity, "warning");
  assert.equal(findings[0]?.evidence["approval_kind"], "operator");

  const listed = await findingsOf(
    new UnlimitedApprovalRule({ incidentRegistry: [SPENDER as never] }),
    context(tx, diffWriting(slot, uint(1n), COLLECTION), token({ operator: true })),
  );
  assert.equal(listed[0]?.severity, "critical");
  assert.match(String(listed[0]?.title), /^Operator approval to an address linked/);
});

test("a one-unit allowance on a token is not mistaken for an operator", async () => {
  const slot = allowanceSlot(OWNER, SPENDER, USDC_ALLOWANCE_MAPPING_SLOT);
  assert.deepEqual(
    await findingsOf(
      new UnlimitedApprovalRule(),
      context(transaction(), diffWriting(slot, uint(1n)), token({ totalSupply: USDC_SUPPLY, balance: 10n })),
    ),
    [],
  );
});

test("calling a listed address is critical with no approval at all", async () => {
  const findings = await findingsOf(
    new UnlimitedApprovalRule({ incidentRegistry: [FLAGGED as never] }),
    context(transaction({ to: FLAGGED as never, data: "0x4e71d92d" as never }), diffWriting(`0x${"ab".repeat(32)}`, uint(1n), FLAGGED)),
  );

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.severity, "critical");
  assert.match(String(findings[0]?.title), /^Calls an address linked/);
});

test("value reaching a listed address through another contract is critical", async () => {
  const ROUTER = "0x5555555555555555555555555555555555555555";
  const rule = new UnlimitedApprovalRule({ incidentRegistry: [FLAGGED as never] });

  // ETH, read from balances in the diff: the calldata never names the recipient.
  const eth = await findingsOf(
    rule,
    context(transaction({ to: ROUTER as never, data: "0x12345678" as never }), {
      pre: { [OWNER]: { balance: 10n }, [FLAGGED]: { balance: 0n } },
      post: { [OWNER]: { balance: 4n }, [FLAGGED]: { balance: 6n } },
      blockNumber: 1,
      revertReason: null,
    } as unknown as StateDiff),
  );
  assert.equal(eth.length, 1);
  assert.match(String(eth[0]?.title), /^Sends value to an address linked/);
  assert.equal(eth[0]?.evidence["receives_eth"], true);

  // Tokens, from the effects the engine read once for every rule.
  const effects = {
    observed: true,
    ethOutWei: "0",
    ethRecipients: [],
    tokensOut: [{ token: USDC, amountOut: "100", recipients: [FLAGGED], burned: false, unidentifiedRecipient: false }],
  };
  const tokens = await findingsOf(
    rule,
    context(transaction({ to: ROUTER as never, data: "0x12345678" as never }), diffWriting(`0x${"ab".repeat(32)}`, uint(1n)), undefined, { effects }),
  );
  assert.equal(tokens.length, 1);
  assert.deepEqual(tokens[0]?.evidence["receives_tokens"], [USDC]);
});

test("calldata padded past the candidate bound is refused rather than half-read", async () => {
  const decoys = Array.from({ length: MAX_ADDRESS_CANDIDATES + 10 }, (_, i) =>
    `${(i + 1).toString(16).padStart(8, "0")}${"a".repeat(32)}`.padStart(64, "0"),
  ).join("");
  const outcome = (await new UnlimitedApprovalRule().evaluate(
    context(transaction({ data: `0x12345678${decoys}` as never }), diffWriting(`0x${"ab".repeat(32)}`, MAX)),
  )) as { status: string; reason?: string };

  // Scanning on would cost seconds per verdict; stopping quietly would call
  // the spender past the bound checked. Neither is acceptable.
  assert.equal(outcome.status, "unavailable");
  assert.equal(outcome.reason, "too_many_candidates");
});

test("proves an unlimited approval from the diff, naming the mapping slot", async () => {
  const slot = allowanceSlot(OWNER, SPENDER, USDC_ALLOWANCE_MAPPING_SLOT);
  const findings = await findingsOf(
    new UnlimitedApprovalRule(),
    context(transaction(), diffWriting(slot, MAX)),
  );

  assert.equal(findings.length, 1);
  const [finding] = findings;
  assert.equal(finding?.ruleId, "R1");
  assert.equal(finding?.evidence["spender"], SPENDER);
  assert.equal(finding?.evidence["mapping_slot"], USDC_ALLOWANCE_MAPPING_SLOT);
  assert.equal(finding?.evidence["is_exact_max"], true);
  // The claim rests on the observed write, not on the calldata.
  assert.equal(finding?.evidence["derived_from"], "state_diff");
});

test("catches an approval the calldata does not mention", async () => {
  const slot = allowanceSlot(OWNER, SPENDER, USDC_ALLOWANCE_MAPPING_SLOT);

  // A router call whose calldata names the spender nowhere. Decoding
  // `approve` would find nothing here; the write is unmistakable.
  const tx = transaction({ to: SPENDER, data: "0xdeadbeef" });
  const findings = await findingsOf(
    new UnlimitedApprovalRule(),
    context(tx, diffWriting(slot, MAX)),
  );

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.evidence["spender"], SPENDER);
});

test("ignores a bounded approval", async () => {
  const slot = allowanceSlot(OWNER, SPENDER, USDC_ALLOWANCE_MAPPING_SLOT);
  const thousandUsdc = `0x${(1000n * 10n ** 6n).toString(16).padStart(64, "0")}`;

  assert.deepEqual(
    await findingsOf(
      new UnlimitedApprovalRule(),
      context(transaction(), diffWriting(slot, thousandUsdc)),
    ),
    [],
  );
});

test("ignores a large write that is not an allowance slot", async () => {
  // Same value, unrelated slot: without the mapping proof this would be a
  // false positive, and a scanner that flags healthy contracts is worse than
  // one with narrow coverage.
  assert.deepEqual(
    await findingsOf(
      new UnlimitedApprovalRule(),
      context(transaction(), diffWriting(`0x${"ab".repeat(32)}`, MAX)),
    ),
    [],
  );
});

test("reports nothing when the transaction reverts", async () => {
  const slot = allowanceSlot(OWNER, SPENDER, USDC_ALLOWANCE_MAPPING_SLOT);
  const diff = { ...diffWriting(slot, MAX), revertReason: "execution reverted" };

  // An approval that never lands must not be reported, or callers learn to
  // ignore the rule.
  assert.deepEqual(
    await findingsOf(new UnlimitedApprovalRule(), context(transaction(), diff)),
    [],
  );
});

test("honours an allowlisted spender", async () => {
  const slot = allowanceSlot(OWNER, SPENDER, USDC_ALLOWANCE_MAPPING_SLOT);
  const rule = new UnlimitedApprovalRule({ allowlist: [SPENDER as never] });

  assert.deepEqual(
    await findingsOf(rule, context(transaction(), diffWriting(slot, MAX))),
    [],
  );
});

test("escalates to critical for a spender in the incident registry", async () => {
  const slot = allowanceSlot(OWNER, SPENDER, USDC_ALLOWANCE_MAPPING_SLOT);
  const rule = new UnlimitedApprovalRule({ incidentRegistry: [SPENDER as never] });

  const findings = await findingsOf(
    rule,
    context(transaction(), diffWriting(slot, MAX)),
  );

  assert.equal(findings[0]?.severity, "critical");
  assert.match(String(findings[0]?.title), /known incident/i);
});

test("a bounded approval to a flagged spender is still critical", async () => {
  const slot = allowanceSlot(OWNER, SPENDER, USDC_ALLOWANCE_MAPPING_SLOT);
  const thousandUsdc = `0x${(1000n * 10n ** 6n).toString(16).padStart(64, "0")}`;
  const rule = new UnlimitedApprovalRule({ incidentRegistry: [SPENDER as never] });

  const findings = await findingsOf(
    rule,
    context(transaction(), diffWriting(slot, thousandUsdc)),
  );

  // The limit caps what a drainer can take; it does not make the approval
  // reasonable. The same amount to an unlisted spender is ignored above.
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.severity, "critical");
  assert.match(String(findings[0]?.title), /^Approval to an address linked/);
});

test("a revocation to a flagged spender is not reported", async () => {
  const slot = allowanceSlot(OWNER, SPENDER, USDC_ALLOWANCE_MAPPING_SLOT);
  const rule = new UnlimitedApprovalRule({ incidentRegistry: [SPENDER as never] });

  assert.deepEqual(
    await findingsOf(rule, context(transaction(), diffWriting(slot, `0x${"0".repeat(64)}`))),
    [],
  );
});

test("a flagged finding names the list and when it was fetched", async () => {
  const slot = allowanceSlot(OWNER, SPENDER, USDC_ALLOWANCE_MAPPING_SLOT);
  const registry = {
    has: (address: string) => address.toLowerCase() === SPENDER,
    status: () => ({
      source: "ScamSniffer scam-database",
      url: "https://example.invalid/address.json",
      loaded: true,
      entries: 2530,
      fetchedAt: "2026-09-11T00:00:00.000Z",
      lastError: null,
      note: "",
    }),
  };

  const findings = await findingsOf(
    new UnlimitedApprovalRule({ incidentRegistry: registry }),
    context(transaction(), diffWriting(slot, MAX)),
  );

  // "In the incident registry" is a claim a reader cannot check. Which list,
  // how large and as of when is one they can.
  assert.deepEqual(findings[0]?.evidence["incident_registry"], {
    source: "ScamSniffer scam-database",
    url: "https://example.invalid/address.json",
    entries: 2530,
    fetched_at: "2026-09-11T00:00:00.000Z",
  });
  assert.match(String(findings[0]?.title), /known incident/);
});

test("the list is named on the outcome whether or not anything matched", async () => {
  const slot = allowanceSlot(OWNER, SPENDER, USDC_ALLOWANCE_MAPPING_SLOT);
  const thousandUsdc = `0x${(1000n * 10n ** 6n).toString(16).padStart(64, "0")}`;
  const outcome = (await new UnlimitedApprovalRule({
    incidentRegistry: ["0x000000000000000000000000000000000000beef" as never],
  }).evaluate(context(transaction(), diffWriting(slot, thousandUsdc)))) as {
    findings: unknown[];
    lists?: { source: string; entries: number; fetchedAt: string | null }[];
  };

  // Nothing matched, and the verdict still says which list said so.
  assert.deepEqual(outcome.findings, []);
  assert.deepEqual(outcome.lists, [
    { source: "configured list", url: null, entries: 1, fetchedAt: null },
  ]);

  const bare = (await new UnlimitedApprovalRule().evaluate(
    context(transaction(), diffWriting(slot, thousandUsdc)),
  )) as { lists?: unknown };
  // No list configured means no list consulted, which is not a list of zero.
  assert.equal(bare.lists, undefined);
});

test("flags a very large approval that is not exactly max", async () => {
  const slot = allowanceSlot(OWNER, SPENDER, USDC_ALLOWANCE_MAPPING_SLOT);
  const huge = `0x${(2n ** 200n).toString(16).padStart(64, "0")}`;

  const findings = await findingsOf(
    new UnlimitedApprovalRule(),
    context(transaction(), diffWriting(slot, huge)),
  );

  // Matching only type(uint256).max would miss the common evasion of
  // approving an astronomically large but non-maximal amount.
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.evidence["is_exact_max"], false);
});
