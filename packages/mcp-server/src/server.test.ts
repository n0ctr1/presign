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
