import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { RegistrySubprocess, registryEnvironment } from "../../dist/index.js";

/**
 * A stand-in registry. `normal` answers; `exit` dies at once; `flaky` dies the
 * first time it runs and answers after that; `silent` never answers.
 */
const dir = mkdtempSync(join(tmpdir(), "presign-registry-"));
const script = join(dir, "registry.cjs");
writeFileSync(
  script,
  `
const fs = require("node:fs");
const [mode, marker] = process.argv.slice(2);
if (mode === "exit") process.exit(0);
if (mode === "flaky" && !fs.existsSync(marker)) { fs.writeFileSync(marker, "1"); process.exit(0); }
if (mode === "silent") { setInterval(() => {}, 1000); return; }
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.id === undefined) continue;
    const result = message.method === "initialize"
      ? { protocolVersion: "2024-11-05" }
      : { secret: process.env.HEDERA_TESTNET_SERVICE_KEY ?? null, studio: process.env.THE_GRAPH_STUDIO_API_KEY ?? null };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
  }
});
`,
);

const registry = (mode: string, extra: object = {}) =>
  new RegistrySubprocess({
    command: process.execPath,
    args: [script, mode, join(dir, `marker-${Math.random()}`)],
    clientName: "test",
    timeoutMs: 2_000,
    restartDelayMs: 50,
    env: registryEnvironment({ PATH: process.env["PATH"], HOME: process.env["HOME"] }),
    ...extra,
  });

test("a working registry answers tool calls", async () => {
  const client = registry("normal");
  assert.deepEqual(await client.callTool("anything", {}), { secret: null, studio: null });
  client.close();
});

test("a command that does not exist fails the call, not the process", async () => {
  // spawn emits `error` for a missing binary; unhandled, that ended the host.
  const client = new RegistrySubprocess({
    command: join(dir, "no-such-registry"),
    clientName: "test",
    timeoutMs: 2_000,
  });
  await assert.rejects(client.callTool("anything", {}), /ENOENT|exited/);
  client.close();
});

test("a registry that dies is reported at once and restarted on a later call", async () => {
  const marker = join(dir, `flaky-${Math.random()}`);
  const client = new RegistrySubprocess({
    command: process.execPath,
    args: [script, "flaky", marker],
    clientName: "test",
    timeoutMs: 2_000,
    restartDelayMs: 50,
    env: registryEnvironment({ PATH: process.env["PATH"] }),
  });

  // Not a fifteen-second wait for an answer that will never come.
  const started = Date.now();
  await assert.rejects(client.callTool("anything", {}), /exited/);
  assert.ok(Date.now() - started < 1_500);

  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(await client.callTool("anything", {}), { secret: null, studio: null });
  client.close();
});

test("a handshake nobody is waiting on can time out without an unhandled rejection", async () => {
  const client = registry("silent", { timeoutMs: 100 });
  // No call yet. The test runner fails on an unhandled rejection, so reaching
  // the assertion below is the evidence.
  await new Promise((resolve) => setTimeout(resolve, 250));
  await new Promise((resolve) => setTimeout(resolve, 60));
  await assert.rejects(client.callTool("anything", {}), /did not answer|restarting|initialize/);
  client.close();
});

test("the registry sees none of the service's credentials", async () => {
  const env = registryEnvironment({
    PATH: process.env["PATH"],
    HEDERA_TESTNET_SERVICE_KEY: "302e...operator",
    ETH_RPC_URL: "https://eth-mainnet.example/v2/secret",
    BASE_PAYER_KEY: "0xabc",
    THE_GRAPH_STUDIO_API_KEY: "studio",
  });

  assert.equal(env["HEDERA_TESTNET_SERVICE_KEY"], undefined);
  assert.equal(env["ETH_RPC_URL"], undefined);
  assert.equal(env["BASE_PAYER_KEY"], undefined);

  const client = registry("normal", { env });
  assert.deepEqual(await client.callTool("anything", {}), { secret: null, studio: "studio" });
  client.close();
});
