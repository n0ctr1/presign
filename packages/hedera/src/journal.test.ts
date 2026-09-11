import assert from "node:assert/strict";
import { test } from "node:test";

import {
  commitTransaction,
  hashTransaction,
  newSalt,
  toEntry,
  InMemoryVerdictJournal,
} from "../dist/index.js";
import type { UnsignedTransaction, Verdict } from "@presign/verdict-engine";

const SALT = "5f1d3c0e9a7b6d2c4e8f0a1b3c5d7e9f";

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
  const serialised = JSON.stringify(toEntry(tx, verdict, SALT));

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

test("the entry commits to the transaction only through the caller's salt", () => {
  const entry = toEntry(tx, verdict, SALT);

  /*
   * An unsalted hash of a guessable transaction is a lookup, not a secret: an
   * agent's address is public and an approval to Permit2 has one calldata.
   * The public entry must not be matchable from the transaction alone.
   */
  assert.notEqual(entry.txCommitment, hashTransaction(tx));
  assert.equal(entry.txCommitment, commitTransaction(tx, SALT));
  assert.notEqual(commitTransaction(tx, newSalt()), entry.txCommitment);
  assert.ok(!JSON.stringify(entry).includes(SALT));
});

test("the entry keeps what makes a verdict auditable", () => {
  const entry = toEntry(tx, verdict, SALT);

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
  const bytes = Buffer.byteLength(JSON.stringify(toEntry(tx, verdict, SALT)), "utf8");

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
  // The caller needs the salt to ever match this entry to its transaction.
  assert.match(receipt.salt, /^[0-9a-f]{32}$/);
  assert.equal(receipt.entry.txCommitment, commitTransaction(tx, receipt.salt));
});
