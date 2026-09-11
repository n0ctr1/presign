#!/usr/bin/env node
/** stdio entry point: `npx presign-verdict-mcp`. */

import { homedir } from "node:os";
import { join } from "node:path";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  createPayer,
  formatTinybars,
  hbarToTinybars,
  resolveKey,
  type Payer,
} from "@presign/payer";
import {
  EnvSecretSource,
  FileSecretSource,
  SecretResolver,
  WalletCliRingSource,
} from "@presign/secrets";

import { createVerdictServer } from "./server.js";

// stdout is the MCP transport. Anything written there that is not a JSON-RPC
// frame corrupts the stream, so every diagnostic goes to stderr.
const say = (line: string) => process.stderr.write(`presign-verdict-mcp: ${line}\n`);

const network = process.env["HEDERA_NETWORK"] ?? "hedera:testnet";
const short = network === "hedera:mainnet" ? "mainnet" : "testnet";
const baseUrl = process.env["PRESIGN_URL"] ?? "https://presign.dev";

/*
 * The Ledger Key Ring first, then files, then the environment.
 *
 * This process is a broker: the model gets a budget-capped `get_verdict`, and
 * the key that pays for it never enters the model's context. The ring is what
 * makes the other half true — with the key sealed by `wallet-cli ring encrypt`
 * it is not in a file, an MCP config or a shell history either. It comes first
 * so a leftover plaintext copy cannot shadow it, and a ring that refuses to
 * decrypt stops here rather than falling through to that copy.
 *
 * Files and the environment remain for anyone without a Ledger. MCP clients
 * usually pass configuration as environment variables.
 */
const secrets = new SecretResolver([
  new WalletCliRingSource({
    directory: process.env["PRESIGN_RING_DIR"] ?? join(homedir(), ".presign", "ring"),
  }),
  new FileSecretSource(process.env["PRESIGN_SECRETS_DIR"] ?? join(homedir(), ".presign", "secrets")),
  new EnvSecretSource(),
]);
const read = async (name: string): Promise<string | null> => {
  try {
    const resolved = await secrets.resolve({ scope: "hedera", name });
    // Where the key came from is the first thing to check if it might have
    // leaked, so it is said on every start.
    say(`hedera ${name} from ${resolved.source} (${resolved.protection})`);
    return resolved.value;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/not found|no source/i.test(message)) say(`could not read hedera ${name}: ${message}`);
    return null;
  }
};

const upper = short.toUpperCase();
const setupHint =
  `Put a Hedera ${short} account id and private key in ~/.presign/secrets/hedera__${short}-agent-id and ` +
  `~/.presign/secrets/hedera__${short}-agent-key, or set HEDERA_${upper}_AGENT_ID and HEDERA_${upper}_AGENT_KEY ` +
  "in this server's environment. A free testnet account with 1000 HBAR comes from portal.hedera.com.";

const accountId = await read(`${short}-agent-id`);
const rawKey = await read(`${short}-agent-key`);

let payer: Payer | null = null;
if (accountId !== null && rawKey !== null) {
  try {
    const budget = hbarToTinybars(process.env["PRESIGN_SESSION_BUDGET_HBAR"] ?? "0.1");
    payer = createPayer({
      accountId,
      privateKey: await resolveKey(rawKey, accountId, network),
      network,
      maxPerPaymentTinybars: hbarToTinybars(process.env["PRESIGN_MAX_PER_PAYMENT_HBAR"] ?? "0.05"),
      sessionBudgetTinybars: budget,
    });
    say(`paying from ${accountId} on ${network}, session budget ${formatTinybars(budget)}`);
  } catch (error) {
    say(`payer unavailable — ${error instanceof Error ? error.message : String(error)}`);
  }
} else {
  say("no Hedera account configured; get_verdict will explain how to add one");
}

const server = createVerdictServer({ baseUrl, payer, setupHint });
await server.connect(new StdioServerTransport());
say(`ready on stdio, verdicts from ${baseUrl}`);
