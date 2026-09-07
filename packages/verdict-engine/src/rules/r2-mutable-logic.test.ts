import assert from "node:assert/strict";
import { test } from "node:test";

import {
  eip1967Slot,
  humanDuration,
  EIP1967_ADMIN_SLOT,
  EIP1967_IMPLEMENTATION_SLOT,
  MutableLogicRule,
  ZEPPELINOS_IMPLEMENTATION_SLOT,
} from "../../dist/index.js";
import type { StateDiff, UnsignedTransaction } from "../../dist/index.js";

const PROXY = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const IMPL = "0x43506849d7c04f9138d1a2050bbf3a0c054402dd";
const ADMIN = "0x807a96288a1a408dbc13de2b1d087d10356395d2";
const AGENT = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const ZERO = `0x${"0".repeat(64)}`;

const word = (address: string) => `0x${address.slice(2).padStart(64, "0")}`;
const uint = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`;

function transaction(to: string | null = PROXY) {
  return { from: AGENT, to, value: 0n, data: "0x", chainId: 1 } as UnsignedTransaction;
}

const emptyDiff = {
  pre: {},
  post: {},
  blockNumber: 25916120,
  revertReason: null,
} as unknown as StateDiff;

interface World {
  storage?: Record<string, string>;
  code?: Record<string, string>;
  calls?: Record<string, string | null>;
}

async function findingsOf(rule: { evaluate: (c: never) => Promise<unknown> }, ctx: never) {
  const outcome = (await rule.evaluate(ctx)) as {
    status: string;
    findings?: readonly {
      severity: string; title: string; detail: string; evidence: Record<string, unknown>;
    }[];
  };
  assert.equal(outcome.status, "evaluated");
  return outcome.findings ?? [];
}

function context(world: World, tx = transaction(), diff = emptyDiff) {
  return {
    transaction: tx,
    diff,
    getStorageAt: (_a: string, slot: string) =>
      Promise.resolve(world.storage?.[slot.toLowerCase()] ?? ZERO),
    getCode: (address: string) =>
      Promise.resolve(world.code?.[address.toLowerCase()] ?? "0x"),
    call: (address: string, data: string) =>
      Promise.resolve(world.calls?.[`${address.toLowerCase()}:${data}`] ?? null),
  } as never;
}

test("slot constants are derived from their EIP preimages, not copied", () => {
  // If these ever drift, every proxy check silently starts reading zeros.
  assert.equal(eip1967Slot("eip1967.proxy.implementation"), EIP1967_IMPLEMENTATION_SLOT);
  assert.equal(eip1967Slot("eip1967.proxy.admin"), EIP1967_ADMIN_SLOT);
});

test("reports nothing for a contract that is not a proxy", async () => {
  assert.deepEqual(await findingsOf(new MutableLogicRule(), context({})), []);
});

test("reports nothing for contract creation", async () => {
  const findings = await findingsOf(new MutableLogicRule(), 
    context({}, transaction(null)),
  );
  assert.deepEqual(findings, []);
});

test("an EOA admin is critical: one key, no delay, no notice", async () => {
  // USDC's real shape, confirmed on mainnet: a zeppelinos proxy whose admin
  // has no code at all.
  const findings = await findingsOf(new MutableLogicRule(), 
    context({
      storage: {
        [ZEPPELINOS_IMPLEMENTATION_SLOT]: word(IMPL),
        "0x10d6a54a4754c8869d6886b5f5d7fbfa5b4522237ea5c60d11bc4e7a1ff9390b":
          word(ADMIN),
      },
    }),
  );

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.severity, "critical");
  assert.equal(findings[0]?.evidence["admin_is_contract"], false);
  assert.equal(findings[0]?.evidence["standard"], "zeppelinos");
});

test("a timelock beyond the threshold downgrades to info", async () => {
  const findings = await findingsOf(new MutableLogicRule(), 
    context({
      storage: {
        [EIP1967_IMPLEMENTATION_SLOT]: word(IMPL),
        [EIP1967_ADMIN_SLOT]: word(ADMIN),
      },
      code: { [ADMIN]: "0x6080604052" },
      calls: { [`${ADMIN}:0xf27a0c92`]: uint(172_800n) },
    }),
  );

  assert.equal(findings[0]?.severity, "info");
  assert.equal(findings[0]?.evidence["timelock_delay_seconds"], 172_800);
  assert.match(String(findings[0]?.evidence["timelock_flavour"]), /OpenZeppelin/);
});

test("a short timelock stays a warning", async () => {
  const findings = await findingsOf(new MutableLogicRule(), 
    context({
      storage: {
        [EIP1967_IMPLEMENTATION_SLOT]: word(IMPL),
        [EIP1967_ADMIN_SLOT]: word(ADMIN),
      },
      code: { [ADMIN]: "0x6080604052" },
      // Ten minutes protects nobody who is asleep.
      calls: { [`${ADMIN}:0xf27a0c92`]: uint(600n) },
    }),
  );

  assert.equal(findings[0]?.severity, "warning");
  assert.match(String(findings[0]?.title), /short timelock/i);
});

test("a contract admin with no recognised timelock interface is a warning", async () => {
  const findings = await findingsOf(new MutableLogicRule(), 
    context({
      storage: {
        [EIP1967_IMPLEMENTATION_SLOT]: word(IMPL),
        [EIP1967_ADMIN_SLOT]: word(ADMIN),
      },
      code: { [ADMIN]: "0x6080604052" },
    }),
  );

  assert.equal(findings[0]?.severity, "warning");
  // It may well be a multisig. The rule says what it can prove, not what it
  // hopes.
  assert.match(String(findings[0]?.detail), /not verifiable/i);
});

test("an upgrade inside this very transaction is critical", async () => {
  const newImpl = "0x1111111111111111111111111111111111111111";
  const diff = {
    pre: {},
    post: { [PROXY]: { storage: { [EIP1967_IMPLEMENTATION_SLOT]: word(newImpl) } } },
    blockNumber: 25916120,
    revertReason: null,
  } as unknown as StateDiff;

  const findings = await findingsOf(new MutableLogicRule(), 
    context(
      {
        storage: {
          [EIP1967_IMPLEMENTATION_SLOT]: word(IMPL),
          [EIP1967_ADMIN_SLOT]: word(ADMIN),
        },
      },
      transaction(),
      diff,
    ),
  );

  const upgrade = findings.find((f) => /replaces the contract/i.test(f.title));
  assert.ok(upgrade, "expected an in-transaction upgrade finding");
  assert.equal(upgrade.severity, "critical");
  assert.equal(upgrade.evidence["new_implementation"], newImpl);
  assert.equal(upgrade.evidence["derived_from"], "state_diff");
});

test("an allowlisted admin suppresses the admin finding", async () => {
  const rule = new MutableLogicRule({ allowlist: [ADMIN as never] });

  const findings = await findingsOf(rule,
    context({
      storage: {
        [EIP1967_IMPLEMENTATION_SLOT]: word(IMPL),
        [EIP1967_ADMIN_SLOT]: word(ADMIN),
      },
    }),
  );

  assert.deepEqual(findings, []);
});

test("an empty admin slot is reported, not assumed immutable", async () => {
  // Aave V3's real shape: a proxy whose upgrade authority lives in external
  // governance. Absence of an admin here is not proof nobody can upgrade.
  const findings = await findingsOf(new MutableLogicRule(), 
    context({ storage: { [EIP1967_IMPLEMENTATION_SLOT]: word(IMPL) } }),
  );

  assert.equal(findings[0]?.severity, "info");
  assert.equal(findings[0]?.evidence["admin_slot_empty"], true);
});

/** Minimal stand-in for the Substreams-backed index. */
const historyWith = (
  record: { block: number; timestamp: number; implementation: string } | null,
  watchedSince: number | null = 25_900_000,
) => ({ lastUpgrade: () => record, watchedSince });

const NOW = new Date("2026-09-07T12:00:00Z");
const secondsAgo = (s: number) => Math.round(NOW.getTime() / 1000) - s;

const proxyWorld = {
  storage: {
    [EIP1967_IMPLEMENTATION_SLOT]: word(IMPL),
    [EIP1967_ADMIN_SLOT]: word(ADMIN),
  },
};

async function findingsWithHistory(history: unknown) {
  const rule = new MutableLogicRule({
    upgradeHistory: history as never,
    now: () => NOW,
  });
  const outcome = (await rule.evaluate(context(proxyWorld))) as {
    status: string;
    findings: readonly { severity: string; title: string; evidence: Record<string, unknown> }[];
  };
  assert.equal(outcome.status, "evaluated");
  return outcome.findings;
}

test("a recent upgrade earns its own finding", async () => {
  const findings = await findingsWithHistory(
    historyWith({ block: 25_927_009, timestamp: secondsAgo(2 * 3600), implementation: IMPL }),
  );

  const upgrade = findings.find((f) => /Implementation changed/.test(f.title));
  assert.ok(upgrade, "expected a recency finding");
  assert.equal(upgrade.severity, "critical");
  assert.match(upgrade.title, /2\.0 hours ago/);
  // The detail is written for a device screen, where the human decides.
  assert.match(upgrade.detail as never, /no longer running/);
  assert.equal(upgrade.evidence["derived_from"], "substreams");
});

test("an old upgrade is evidence, not a finding", async () => {
  const findings = await findingsWithHistory(
    historyWith({ block: 25_000_000, timestamp: secondsAgo(40 * 3600), implementation: IMPL }),
  );

  assert.equal(findings.filter((f) => /Implementation changed/.test(f.title)).length, 0);
  const history = findings[0]?.evidence["upgrade_history"] as Record<string, unknown>;
  assert.equal(history["upgrade_seen"], true);
  assert.equal(history["recent"], false);
  assert.equal(history["seconds_since_upgrade"], 40 * 3600);
});

test("nothing seen is recorded as unknown, not as never", async () => {
  const findings = await findingsWithHistory(historyWith(null));

  const history = findings[0]?.evidence["upgrade_history"] as Record<string, unknown>;
  assert.equal(history["upgrade_seen"], false);
  assert.equal(history["watched_since_block"], 25_900_000);
  // Absence within a window is not proof of absence.
  assert.match(String(history["note"]), /not evidence that none occurred earlier/);
});

test("no stream configured is distinguishable from nothing seen", async () => {
  const outcome = (await new MutableLogicRule().evaluate(context(proxyWorld))) as {
    findings: readonly { evidence: Record<string, unknown> }[];
  };

  const history = outcome.findings[0]?.evidence["upgrade_history"] as Record<string, unknown>;
  // A reader must be able to tell "no upgrade seen" from "nobody was watching".
  assert.equal(history["available"], false);
  assert.ok(!("upgrade_seen" in history));
});

test("history reaches the empty-admin case too", async () => {
  const rule = new MutableLogicRule({
    upgradeHistory: historyWith({
      block: 25_927_009,
      timestamp: secondsAgo(3600),
      implementation: IMPL,
    }) as never,
    now: () => NOW,
  });

  const outcome = (await rule.evaluate(
    context({ storage: { [EIP1967_IMPLEMENTATION_SLOT]: word(IMPL) } }),
  )) as { findings: readonly { title: string }[] };

  // Aave V3's shape: governance elsewhere, admin slot empty. The upgrade
  // recency matters just as much there, so the early return must not skip it.
  assert.ok(outcome.findings.some((f) => /Implementation changed/.test(f.title)));
});


test("durations are written for a device screen, not a spreadsheet", () => {
  // An upgrade 87 seconds old rendered as "0.0 hours ago" says nothing to
  // someone holding a hardware wallet. Observed live at 87 seconds.
  assert.equal(humanDuration(87), "87 seconds");
  assert.equal(humanDuration(200), "3 minutes");
  assert.equal(humanDuration(60 * 60), "60 minutes");
  assert.equal(humanDuration(3 * 3600), "3.0 hours");
  assert.equal(humanDuration(72 * 3600), "3 days");
});

test("a stopped stream reports unavailable, not a clean history", async () => {
  const dead = { lastUpgrade: () => null, watchedSince: 25_900_000, live: false };

  const rule = new MutableLogicRule({ upgradeHistory: dead as never, now: () => NOW });
  const outcome = (await rule.evaluate(context(proxyWorld))) as {
    findings: readonly { evidence: Record<string, unknown> }[];
  };
  const history = outcome.findings[0]?.evidence["upgrade_history"] as Record<string, unknown>;

  /*
   * The failure this prevents: a stream that died an hour ago keeps answering
   * "no upgrade seen", and the rule reports a quiet history for a contract it
   * has not been watching. Silence from something that stopped listening is
   * not evidence.
   */
  assert.equal(history["available"], false);
  assert.match(String(history["reason"]), /not live/);
});

test("a source without a liveness signal is trusted, since it cannot go stale", async () => {
  const staticHistory = { lastUpgrade: () => null, watchedSince: 25_900_000 };

  const rule = new MutableLogicRule({ upgradeHistory: staticHistory as never, now: () => NOW });
  const outcome = (await rule.evaluate(context(proxyWorld))) as {
    findings: readonly { evidence: Record<string, unknown> }[];
  };
  const history = outcome.findings[0]?.evidence["upgrade_history"] as Record<string, unknown>;

  assert.equal(history["available"], true);
  assert.equal(history["upgrade_seen"], false);
});
