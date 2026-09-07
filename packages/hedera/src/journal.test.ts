import assert from "node:assert/strict";
import { test } from "node:test";

import { hashTransaction, toEntry, InMemoryVerdictJournal } from "../dist/index.js";
import type { UnsignedTransaction, Verdict } from "@presign/verdict-engine";

const SPENDER = "00000000000000000000000000000000deadbeef".padStart(64, "0");

const tx = {
  from: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  to: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  value: 0n,
  data: `0x095ea7b3${SPENDER}${"f".repeat(64)}`,
  chainId: 1,
} as UnsignedTransaction;

const verdict = {
  tier: "high",
  action: "",
  findings: [
    { ruleId: "R1", severity: "critical", title: "Unlimited approval", detail: "", evidence: {} },
    { ruleId: "R2", severity: "critical", title: "Upgradeable", detail: "", evidence: {} },
    { ruleId: "R2", severity: "info", title: "Background detail", detail: "", evidence: {} },
  ],
  provenance: {
    simulatedAtBlock: 25921807,
    chainId: 1,
    sources: [
      {
        deploymentId: "QmcXE5QV",
        displayName: "Aave V3 Ethereum",
        effectiveLagSeconds: 4.3,
        measuredAt: "2026-09-07T04:53:00Z",
      },
    ],
    unavailableRules: [{ ruleId: "R3", reason: "all_candidates_stale" }],
  },
  evaluatedAt: "2026-09-07T04:53:22.970Z",
} as unknown as Verdict;

test("the published entry never contains the transaction itself", () => {
  const serialised = JSON.stringify(toEntry(tx, verdict));

  // A consensus log is public and permanent. Publishing `to`, `value` and
  // calldata would broadcast the agent's strategy to anyone watching the
  // topic, for every customer at once. This is the assertion that keeps an
  // audit trail from becoming a surveillance feed.
  assert.ok(!serialised.includes(tx.data));
  assert.ok(!serialised.includes("a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"));
  assert.ok(!serialised.includes("deadbeef"));
  assert.ok(!serialised.includes("f39fd6e51aad88f6f4ce6ab8827279cfffb92266"));
});

test("the hash is canonical across equivalent spellings", () => {
  const shouted = {
    ...tx,
    from: tx.from.toUpperCase() as never,
    to: tx.to!.toUpperCase() as never,
    data: tx.data.toUpperCase() as never,
  };

  // Without this, a verdict could not be matched to its record later, which
  // would leave the journal immutable and useless at the same time.
  assert.equal(hashTransaction(shouted), hashTransaction(tx));
});

test("a different transaction hashes differently", () => {
  assert.notEqual(
    hashTransaction({ ...tx, value: 1n } as UnsignedTransaction),
    hashTransaction(tx),
  );
  assert.notEqual(
    hashTransaction({ ...tx, chainId: 8453 } as UnsignedTransaction),
    hashTransaction(tx),
  );
});

test("contract creation hashes without a recipient", () => {
  const creation = { ...tx, to: null } as UnsignedTransaction;
  assert.match(hashTransaction(creation), /^[0-9a-f]{64}$/);
});

test("the entry keeps what makes a verdict auditable", () => {
  const entry = toEntry(tx, verdict);

  assert.equal(entry.tier, "high");
  // Info findings are noise in an audit trail; the rules that fired are not.
  assert.deepEqual(entry.rules, ["R1", "R2"]);
  assert.deepEqual(entry.sources, [{ id: "QmcXE5QV", lag: 4.3 }]);
  // Why a tier was unavailable matters more than that it was.
  assert.deepEqual(entry.unavailable, [
    { rule: "R3", why: "all_candidates_stale" },
  ]);
  assert.equal(entry.block, 25921807);
});

test("entries stay small enough for a single HCS message", () => {
  const bytes = Buffer.byteLength(JSON.stringify(toEntry(tx, verdict)), "utf8");

  // HCS charges by size and chunks past ~1 KB. Staying inside one message
  // keeps a verdict to one consensus timestamp rather than several.
  assert.ok(bytes < 1024, `entry was ${bytes} bytes`);
});

test("the in-memory journal keeps entries rather than discarding them", async () => {
  const journal = new InMemoryVerdictJournal();

  const receipt = await journal.record(tx, verdict);

  // A no-op journal would let a deployment believe it had an audit trail when
  // it had none, so this one retains entries and marks its timestamps local.
  assert.equal(journal.entries.length, 1);
  assert.equal(receipt.sequenceNumber, 1);
  assert.match(receipt.consensusTimestamp, /^local-/);
});
