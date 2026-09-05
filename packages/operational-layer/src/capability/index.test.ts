import assert from "node:assert/strict";
import { test } from "node:test";

import { CapabilityIndex, effectiveLagSeconds } from "../../dist/index.js";
import type {
  ConformanceReport,
  DeploymentCandidate,
  DeploymentRecord,
  LivenessReport,
  RuleRequirement,
} from "../../dist/index.js";

const R3: RuleRequirement = {
  ruleId: "R3",
  schemaFamily: "lending-cdp",
  rootField: "markets",
  requiredFields: ["totalValueLockedUSD", "totalBorrowBalanceUSD"],
  maxLagSeconds: 30,
};

const T0 = new Date("2026-09-05T12:00:00Z");
const at = (offsetSeconds: number) => new Date(T0.getTime() + offsetSeconds * 1000);

function candidate(id: string, overrides: Partial<DeploymentCandidate> = {}) {
  return {
    deploymentId: id,
    subgraphId: `sub-${id}`,
    displayName: id,
    network: "mainnet",
    schemaFamily: "lending-cdp",
    protocol: null,
    contractAddresses: [],
    reliability: 0.5,
    queryUrl: `https://example.invalid/${id}`,
    queryUrlX402: null,
    ...overrides,
  } as DeploymentCandidate;
}

interface Fixture {
  readonly id: string;
  readonly lagSeconds?: number;
  readonly checkedAt?: Date;
  readonly missing?: readonly string[];
  readonly indexingErrors?: boolean;
  readonly reliability?: number;
  readonly network?: string;
  readonly probeThrows?: boolean;
}

function harness(fixtures: readonly Fixture[], now: () => Date = () => T0) {
  const byId = new Map(fixtures.map((f) => [f.id, f]));

  return new CapabilityIndex({
    discovery: {
      name: "fake",
      findCandidates: () =>
        Promise.resolve(
          fixtures.map((f) =>
            candidate(f.id, {
              reliability: f.reliability ?? 0.5,
              network: f.network ?? "mainnet",
            }),
          ),
        ),
      findByContract: () => Promise.resolve([]),
    },
    conformance: {
      check: (deploymentId: string): Promise<ConformanceReport> => {
        const f = byId.get(deploymentId);
        if (f?.probeThrows) return Promise.reject(new Error("introspection refused"));
        const missing = f?.missing ?? [];
        return Promise.resolve({
          deploymentId,
          answersFields: R3.requiredFields.filter((x) => !missing.includes(x)),
          missingFields: [...missing],
          checkedAt: f?.checkedAt ?? T0,
        });
      },
    },
    liveness: {
      check: (deploymentId: string): Promise<LivenessReport> => {
        const f = byId.get(deploymentId);
        if (f?.probeThrows) return Promise.reject(new Error("gateway timeout"));
        return Promise.resolve({
          deploymentId,
          indexedBlock: 100,
          indexedBlockTimestamp: 1_700_000_000,
          headBlock: 100,
          blocksBehind: 0,
          lagSeconds: f?.lagSeconds ?? 5,
          hasIndexingErrors: f?.indexingErrors ?? false,
          checkedAt: f?.checkedAt ?? T0,
        });
      },
    },
    now,
  });
}

test("reports not_warmed before any warm-up, rather than an empty success", () => {
  const resolution = harness([]).resolve(R3, "mainnet");

  assert.equal(resolution.satisfied, false);
  assert.ok(!resolution.satisfied);
  assert.equal(resolution.reason, "not_warmed");
});

test("resolves a fresh conforming deployment", async () => {
  const index = harness([{ id: "QmFresh", lagSeconds: 5 }]);
  await index.warm(R3, "mainnet");

  const resolution = index.resolve(R3, "mainnet");

  assert.ok(resolution.satisfied);
  assert.equal(resolution.records[0]?.candidate.deploymentId, "QmFresh");
});

test("ages a cached measurement instead of trusting it forever", async () => {
  let clock = T0;
  const index = harness([{ id: "QmFresh", lagSeconds: 5, checkedAt: T0 }], () => clock);
  await index.warm(R3, "mainnet");

  assert.ok(index.resolve(R3, "mainnet").satisfied);

  // Probed at 5s lag, but the measurement is now 40s old. Nothing says the
  // deployment kept up, so the record must be treated as 45s stale and fall
  // outside the 30s budget. Without this a warm cache turns stale data into
  // green verdicts through our own code rather than the indexer's.
  clock = at(40);
  const resolution = index.resolve(R3, "mainnet");

  assert.ok(!resolution.satisfied);
  assert.equal(resolution.reason, "all_candidates_stale");
});

test("effectiveLagSeconds adds measurement age to measured lag", () => {
  const record = {
    liveness: { lagSeconds: 5, checkedAt: T0 },
  } as DeploymentRecord;

  assert.equal(effectiveLagSeconds(record, T0), 5);
  assert.equal(effectiveLagSeconds(record, at(40)), 45);
  // A clock that went backwards must not manufacture freshness.
  assert.equal(effectiveLagSeconds(record, at(-60)), 5);
});

test("distinguishes no_conforming_deployment from staleness", async () => {
  const index = harness([{ id: "QmPartial", missing: ["totalBorrowBalanceUSD"] }]);
  await index.warm(R3, "mainnet");

  const resolution = index.resolve(R3, "mainnet");

  assert.ok(!resolution.satisfied);
  // A partial match is not usable: the rule reads both fields.
  assert.equal(resolution.reason, "no_conforming_deployment");
  assert.equal(resolution.rejected.length, 1);
});

test("reports all_candidates_erroring when every conforming deployment errors", async () => {
  const index = harness([{ id: "QmBroken", indexingErrors: true }]);
  await index.warm(R3, "mainnet");

  const resolution = index.resolve(R3, "mainnet");

  assert.ok(!resolution.satisfied);
  assert.equal(resolution.reason, "all_candidates_erroring");
});

test("reports no_candidates when discovery finds nothing", async () => {
  const index = harness([]);
  await index.warm(R3, "mainnet");

  const resolution = index.resolve(R3, "mainnet");

  assert.ok(!resolution.satisfied);
  assert.equal(resolution.reason, "no_candidates");
});

test("orders by freshness and never by reliability", async () => {
  const index = harness([
    { id: "QmPopularButStale", lagSeconds: 25, reliability: 0.99 },
    { id: "QmUnknownButFresh", lagSeconds: 2, reliability: 0.01 },
  ]);
  await index.warm(R3, "mainnet");

  const resolution = index.resolve(R3, "mainnet");

  assert.ok(resolution.satisfied);
  // Reliability is an economic score that tracks traction and therefore age.
  // Letting it order a freshness-gated list reintroduces the exact bias this
  // layer exists to remove.
  assert.deepEqual(
    resolution.records.map((r) => r.candidate.deploymentId),
    ["QmUnknownButFresh", "QmPopularButStale"],
  );
});

test("one unprobeable candidate does not deny the rule the others", async () => {
  const index = harness([
    { id: "QmRefuses", probeThrows: true },
    { id: "QmWorks", lagSeconds: 3 },
  ]);
  await index.warm(R3, "mainnet");

  const resolution = index.resolve(R3, "mainnet");

  assert.ok(resolution.satisfied);
  assert.deepEqual(
    resolution.records.map((r) => r.candidate.deploymentId),
    ["QmWorks"],
  );
});

test("drops candidates indexing a different network", async () => {
  const index = harness([{ id: "QmArbitrum", network: "arbitrum-one" }]);
  await index.warm(R3, "mainnet");

  const resolution = index.resolve(R3, "mainnet");

  assert.ok(!resolution.satisfied);
  // A deployment indexing another chain cannot answer for this transaction,
  // whatever its score.
  assert.equal(resolution.reason, "no_candidates");
});

test("warm returns the resolution it just produced", async () => {
  const index = harness([{ id: "QmFresh", lagSeconds: 5 }]);

  const resolution = await index.warm(R3, "mainnet");

  assert.ok(resolution.satisfied);
  assert.equal(index.warmedAt("R3", "mainnet")?.getTime(), T0.getTime());
});
