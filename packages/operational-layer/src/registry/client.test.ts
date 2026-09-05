import assert from "node:assert/strict";
import { test } from "node:test";

import { SubgraphRegistrySource, type RegistryToolCaller } from "../../dist/index.js";

/**
 * Payloads recorded from `subgraph-registry-mcp@0.9.15` and trimmed to the
 * fields this adapter reads. Recorded rather than hand-written so that a change
 * in the upstream response shape shows up as a failing test here.
 */
function callerReturning(document: unknown): RegistryToolCaller {
  return {
    callTool: () =>
      Promise.resolve({ content: [{ type: "text", text: JSON.stringify(document) }] }),
  };
}

test("maps a search row onto a candidate keyed by deployment id", async () => {
  const source = new SubgraphRegistrySource(
    callerReturning({
      total: 1,
      subgraphs: [
        {
          id: "Cd2gEDVeqnjBn1hSeqFMitw8Q1iiyV9FYUZkLNRcL87g",
          display_name: "protocol-v3",
          protocol_type: "lending",
          network: "mainnet",
          reliability_score: 0.8884,
          ipfs_hash: "QmX2VfvEspbShTdcjefWeG3CKBVXKWm9naxH6TVhqPb9qY",
          query_url: "https://gateway.thegraph.com/api/subgraphs/id/Cd2g",
          query_url_x402: "https://gateway.thegraph.com/api/x402/subgraphs/id/Cd2g",
        },
      ],
    }),
  );

  const [candidate] = await source.findCandidates({ schemaFamily: "lending-cdp" });

  assert.ok(candidate);
  // The pinned deployment, not the floating subgraph id: provenance has to name
  // the deployment that actually answered.
  assert.equal(candidate.deploymentId, "QmX2VfvEspbShTdcjefWeG3CKBVXKWm9naxH6TVhqPb9qY");
  assert.equal(candidate.subgraphId, "Cd2gEDVeqnjBn1hSeqFMitw8Q1iiyV9FYUZkLNRcL87g");
  assert.equal(candidate.schemaFamily, "lending-cdp");
  assert.equal(candidate.reliability, 0.8884);
});

test("keeps emerging rows, which are young rather than unhealthy", async () => {
  const source = new SubgraphRegistrySource(
    callerReturning({
      subgraphs: [
        {
          id: "established",
          ipfs_hash: "QmEstablished",
          network: "mainnet",
          query_url: "https://example.invalid/1",
        },
      ],
      emerging: [
        {
          id: "young",
          ipfs_hash: "QmYoung",
          network: "mainnet",
          query_url: "https://example.invalid/2",
        },
      ],
    }),
  );

  const candidates = await source.findCandidates({ schemaFamily: "dex-amm" });

  // The economic score needs 30 days of volume to exist at all, so a low score
  // on a young deployment says nothing about whether it is indexing now.
  assert.deepEqual(
    candidates.map((c) => c.deploymentId),
    ["QmEstablished", "QmYoung"],
  );
});

test("drops rows with no deployment id instead of substituting the subgraph id", async () => {
  const source = new SubgraphRegistrySource(
    callerReturning({
      subgraphs: [
        { id: "no-hash", network: "mainnet", query_url: "https://example.invalid/1" },
      ],
    }),
  );

  assert.deepEqual(await source.findCandidates({ schemaFamily: "staking" }), []);
});

test("lowercases matched contract addresses from a contract lookup", async () => {
  const source = new SubgraphRegistrySource(
    callerReturning({
      deployments: [
        {
          id: "JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk",
          display_name: "Aave V3 Ethereum",
          protocol_type: "lending",
          network: "mainnet",
          ipfs_hash: "QmcXE5QVcBcvcaJddPxd8mFs6W9xt7STmwfgguoiM6ddAd",
          query_url: "https://gateway.thegraph.com/api/subgraphs/id/JCNW",
          matched_contracts: [
            {
              kind: "ethereum",
              name: "LendingPool",
              address: "0x87870BCA3F3FD6335C3F4CE8392D69350B4FA4E2",
              network: "mainnet",
              startBlock: 16291127,
            },
          ],
        },
      ],
    }),
  );

  const [candidate] = await source.findByContract("0x87870bca", "mainnet");

  assert.ok(candidate);
  assert.deepEqual(candidate.contractAddresses, [
    "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2",
  ]);
});

test("maps an unknown protocol type to null rather than guessing a family", async () => {
  const source = new SubgraphRegistrySource(
    callerReturning({
      subgraphs: [
        {
          id: "bridge",
          ipfs_hash: "QmBridge",
          protocol_type: "bridge",
          network: "mainnet",
          query_url: "https://example.invalid/1",
        },
      ],
    }),
  );

  const [candidate] = await source.findCandidates({ schemaFamily: "lending-cdp" });

  assert.ok(candidate);
  assert.equal(candidate.schemaFamily, null);
});
