import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BudgetExceededError } from "@presign/payer";

import { createVerdictServer } from "../dist/index.js";

const TX = {
  from: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  to: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  value: "0",
  data: "0x",
  chainId: 1,
};

/** A payer double: records what it was asked to fetch, pays nothing. */
function fakePayer(respond: (url: string) => Response | Promise<Response>, remaining: bigint | null = 10_000_000n) {
  const calls: string[] = [];
  return {
    calls,
    payer: {
      fetch: (async (input: string) => {
        calls.push(String(input));
        return respond(String(input));
      }) as unknown as typeof globalThis.fetch,
      spent: 0n,
      budget: remaining,
      remaining,
      payments: [],
    },
  };
}

const verdictBody = (tier: string) =>
  new Response(
    JSON.stringify({
      decision: tier === "low" ? "may_sign" : "refused",
      verdict: { tier, findings: [], provenance: { sources: [], unavailableRules: [] } },
      journal: { mode: "sync", sequence: 1 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

async function connect(config: unknown) {
  const server = createVerdictServer(config as never);
  const client = new Client({ name: "test", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text: string }[];
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

test("offers a free quote, a free health check, and one paid verdict", async () => {
  const client = await connect({ baseUrl: "https://presign.test", payer: null });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["check_service", "get_quote", "get_verdict"]);
});

test("without a configured account, get_verdict explains how to add one instead of failing", async () => {
  const client = await connect({
    baseUrl: "https://presign.test",
    payer: null,
    setupHint: "put a key in ~/.presign/secrets",
  });

  const body = await call(client, "get_verdict", { transaction: TX });

  assert.equal(body["error"], "payer_not_configured");
  assert.match(String(body["setup"]), /presign\/secrets/);
});

test("the verdict carries what to do, and unavailable is never read as low", async () => {
  const { payer, calls } = fakePayer(() => verdictBody("unavailable"));
  const client = await connect({ baseUrl: "https://presign.test", payer });

  const body = await call(client, "get_verdict", { transaction: TX, route: "full", journal: "async" });

  // The route and journal mode reach the service as asked.
  assert.equal(calls[0], "https://presign.test/verdict/full?journal=async");
  // Stated in the result, where a model acting on it will read it.
  assert.match(String(body["what_to_do"]), /Do not sign/);
  assert.match(String(body["what_to_do"]), /NOT evaluated/);
  assert.ok(body["spend"]);
});

test("a spent session budget is reported, and says not to sign", async () => {
  const { payer } = fakePayer(() => {
    throw new BudgetExceededError(9_600_000n, 10_000_000n, 500_000n);
  });
  const client = await connect({ baseUrl: "https://presign.test", payer });

  const body = await call(client, "get_verdict", { transaction: TX });

  assert.equal(body["error"], "session_budget_exceeded");
  assert.equal(body["asked"], "0.005 HBAR");
  assert.match(String(body["what_to_do"]), /Do not sign/);
});

test("a verdict the service did not return is not dressed up as one", async () => {
  const { payer } = fakePayer(() => new Response("upstream down", { status: 503 }));
  const client = await connect({ baseUrl: "https://presign.test", payer });

  const body = await call(client, "get_verdict", { transaction: TX });

  assert.equal(body["error"], "verdict_not_returned");
  assert.match(String(body["what_to_do"]), /Do not sign/);
});

test("an unknown route is rejected by the schema, not sent to the service", async () => {
  const { payer, calls } = fakePayer(() => verdictBody("low"));
  const client = await connect({ baseUrl: "https://presign.test", payer });

  let rejected = false;
  try {
    const result = await client.callTool({ name: "get_verdict", arguments: { transaction: TX, route: "cheap" } });
    rejected = result.isError === true;
  } catch {
    rejected = true;
  }

  assert.equal(rejected, true);
  assert.equal(calls.length, 0);
});

test("with a signing key, get_verdict judges the account that would sign when no sender is given", async () => {
  const bodies: string[] = [];
  const payer = {
    fetch: (async (_input: string, init?: { body?: string }) => {
      bodies.push(init?.body ?? "");
      return verdictBody("low");
    }) as unknown as typeof globalThis.fetch,
    spent: 0n,
    budget: null,
    remaining: null,
    payments: [],
  };
  const signer = "0x6d216c0bb91d346e4b359ab6ee7277134821ffec";
  const client = await connect({
    baseUrl: "https://presign.test",
    payer,
    broker: { account: { address: signer }, chain: { fill: () => Promise.resolve({}) }, approver: null, policy: {} },
  });

  const { to, value, data, chainId } = TX;
  await call(client, "get_verdict", { transaction: { to, value, data, chainId } });
  assert.equal(JSON.parse(bodies[0]!).transaction.from, signer);

  // An explicit sender still wins: the caller may be judging somebody else's wallet.
  await call(client, "get_verdict", { transaction: TX });
  assert.equal(JSON.parse(bodies[1]!).transaction.from, TX.from);
});

test("check_service names the address that would sign, so the sender never has to be guessed", async () => {
  const health = () =>
    new Response(JSON.stringify({ ok: true, rules: ["R1"] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const device = "0xe622e34cfd7d3dce5f8872f1ae9ad090738765d2";
  const withKey = await connect({
    baseUrl: "https://presign.test",
    payer: null,
    fetch: health,
    broker: {
      account: { address: "0x6d216c0bb91d346e4b359ab6ee7277134821ffec" },
      chain: { fill: () => Promise.resolve({}) },
      approver: { address: device },
      policy: {},
    },
  });
  const reported = (await call(withKey, "check_service", {})).signing as Record<string, unknown>;
  assert.equal(reported.signs_as, "0x6d216c0bb91d346e4b359ab6ee7277134821ffec");
  assert.equal(reported.medium_requires_device, true);
  assert.equal(reported.device, device);

  // Without a key there is nothing to default to, and the answer says so.
  const without = await connect({ baseUrl: "https://presign.test", payer: null, fetch: health });
  const none = (await call(without, "check_service", {})).signing as Record<string, unknown>;
  assert.equal(none.available, false);
  assert.equal(none.signs_as, null);
});

test("without a signing key, a missing sender is explained rather than guessed", async () => {
  const { payer } = fakePayer(() => verdictBody("low"));
  const client = await connect({ baseUrl: "https://presign.test", payer });
  const { to, value, data, chainId } = TX;
  const result = await call(client, "get_verdict", { transaction: { to, value, data, chainId } });
  assert.equal(result.error, "from_required");
});
