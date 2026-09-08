import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "../dist/index.js";

const T0 = new Date("2026-09-06T12:00:00Z");

/** Config double: no subprocess, no network, no gateway. */
function fakeConfig(overrides: Record<string, unknown> = {}) {
  return {
    index: {
      warmedAt: () => T0,
      warm: () => Promise.resolve({ satisfied: true, ruleId: "R3", records: [] }),
      resolve: () => ({ satisfied: true, ruleId: "R3", records: [] }),
    },
    discovery: { findByContract: () => Promise.resolve([]) },
    liveness: { check: () => Promise.reject(new Error("not used")) },
    conformance: { check: () => Promise.reject(new Error("not used")) },
    close: () => {},
    ...overrides,
  } as never;
}

/**
 * Drives the server through a real MCP client over a linked in-memory
 * transport, rather than reaching into private internals. Registration,
 * schema validation and content framing are all exercised as a consumer
 * would meet them.
 */
async function connect(config: unknown) {
  const server = createServer(config as never, () => T0);
  const client = new Client({ name: "test", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

async function callTool(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text: string }[];
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

/**
 * A stopped stream that has seen one upgrade, which is the combination that
 * matters: the history is non-empty *and* worthless, and only `live` says so.
 */
function fakeHistory(overrides: Record<string, unknown> = {}) {
  const record = {
    proxy: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    implementation: "0x43506849d7c04f9138d1a2050bbf3a0c054402dd",
    block: 25_916_000,
    timestamp: Math.floor(T0.getTime() / 1000) - 87,
    txHash: "0xabc",
  };
  return {
    lastUpgrade: (proxy: string) => (proxy === record.proxy ? record : null),
    recent: (limit: number) => [record].slice(0, limit),
    watchedSince: 25_915_000,
    live: true,
    failure: null,
    stats: { blocks: 1000, proxies: 1, firstBlock: 25_915_000, lastBlock: 25_916_100 },
    ...overrides,
  };
}

test("exposes the documented tool surface", async () => {
  const client = await connect(fakeConfig());

  const { tools } = await client.listTools();

  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    [
      "check_deployment_conformance",
      "check_deployment_freshness",
      "identify_protocol_by_contract",
      "list_rule_requirements",
      "resolve_rule_capability",
    ],
  );
});

test("without a stream, the upgrade-history tools are not advertised at all", async () => {
  const client = await connect(fakeConfig());

  const { tools } = await client.listTools();

  // A tool that always answered "no history" would be indistinguishable from
  // a proxy with a genuinely clean record, which is worse than its absence.
  assert.ok(!tools.some((tool) => tool.name.includes("upgrade")));
});

test("with a stream, upgrade history is offered and reports the watched window", async () => {
  const client = await connect(fakeConfig({ upgrades: fakeHistory() }));

  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name).filter((n) => n.includes("upgrade")).sort(),
    ["check_proxy_upgrade_history", "list_recent_upgrades"],
  );

  const body = await callTool(client, "check_proxy_upgrade_history", {
    address: "0xA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48",
  });

  assert.equal(body["upgraded"], true);
  const last = body["last_upgrade"] as Record<string, unknown>;
  assert.equal(last["block"], 25_916_000);
  assert.equal(last["age_seconds"], 87);
  const source = body["source"] as Record<string, unknown>;
  assert.equal(source["watched_since_block"], 25_915_000);
});

test("a proxy with no recorded upgrade is bounded by the window, not called clean", async () => {
  const client = await connect(fakeConfig({ upgrades: fakeHistory() }));

  const body = await callTool(client, "check_proxy_upgrade_history", {
    address: "0x0000000000000000000000000000000000000001",
  });

  assert.equal(body["upgraded"], false);
  assert.equal(body["last_upgrade"], null);
  // "Never upgraded" and "upgraded before we started watching" are different
  // claims, and only one of them is ours to make.
  assert.match(String(body["guidance"]), /never as 'never upgraded'/);
});

test("a stopped stream says so on every answer it gives", async () => {
  const client = await connect(
    fakeConfig({
      upgrades: fakeHistory({ live: false, failure: "stream ended" }),
    }),
  );

  const body = await callTool(client, "list_recent_upgrades", { limit: 5 });
  const source = body["source"] as Record<string, unknown>;

  // The list is non-empty and worthless at the same time. Only `live` and
  // `failure` distinguish that from a quiet chain.
  assert.equal((body["upgrades"] as unknown[]).length, 1);
  assert.equal(source["live"], false);
  assert.equal(source["failure"], "stream ended");
  assert.match(String(body["note"]), /watched window/);
});

test("an unsatisfied resolution carries fail-closed guidance inline", async () => {
  const unsatisfied = {
    satisfied: false,
    ruleId: "R3",
    reason: "all_candidates_stale",
    rejected: [],
  };
  const client = await connect(
    fakeConfig({
      index: {
        warmedAt: () => T0,
        resolve: () => unsatisfied,
        warm: () => Promise.resolve(unsatisfied),
      },
    }),
  );

  const body = await callTool(client, "resolve_rule_capability", {
    rule_id: "R3",
    schema_family: "lending-cdp",
    network: "mainnet",
  });

  assert.equal(body["satisfied"], false);
  assert.equal(body["reason"], "all_candidates_stale");
  // The instruction travels with the response. A caller reading only
  // `satisfied` must not be able to mistake "no data" for "no problem".
  assert.match(String(body["guidance"]), /never as low risk/i);
});

test("rejects an unknown rule and family pair with the catalogue", async () => {
  const client = await connect(fakeConfig());

  const body = await callTool(client, "resolve_rule_capability", {
    rule_id: "R9",
    schema_family: "staking",
    network: "mainnet",
  });

  assert.equal(body["error"], "unknown_requirement");
  assert.ok(Array.isArray(body["available"]));
});

test("reports an unindexed contract as identified:false, not as an error", async () => {
  const client = await connect(fakeConfig());

  const body = await callTool(client, "identify_protocol_by_contract", {
    address: "0xABCDEF0000000000000000000000000000000000",
    network: "mainnet",
  });

  // "No indexed protocol claims this address" is a verdict class of its own,
  // and for a contract a transaction is about to touch it is a risk signal.
  assert.equal(body["identified"], false);
  assert.equal(body["address"], "0xabcdef0000000000000000000000000000000000");
});

test("lists only rules that need indexed data", async () => {
  const client = await connect(fakeConfig());

  const body = await callTool(client, "list_rule_requirements", {});
  const requirements = body["requirements"] as { rule_id: string }[];

  assert.ok(requirements.length > 0);
  // R1 reads calldata and the state diff, R2 reads storage slots. Neither has
  // an indexed-data requirement, so neither belongs in this catalogue.
  assert.ok(requirements.every((r) => r.rule_id === "R3"));
});

test("surfaces a probe failure as a structured error, not a transport error", async () => {
  const client = await connect(
    fakeConfig({
      liveness: { check: () => Promise.reject(new Error("gateway timeout")) },
    }),
  );

  const body = await callTool(client, "check_deployment_freshness", {
    deployment_id: "QmUnreachable",
    network: "mainnet",
  });

  assert.equal(body["error"], "probe_failed");
  assert.match(String(body["message"]), /gateway timeout/);
});
