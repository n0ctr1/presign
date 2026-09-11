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
import { formatEther, formatGwei, parseEther, parseGwei } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { DEFAULT_BROKER_POLICY, type BrokerPolicy, type HumanApprover } from "./broker.js";
import { rpcChainReader } from "./chain.js";
import { createVerdictServer, type VerdictServerConfig } from "./server.js";

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
const readSecret = async (scope: string, name: string): Promise<string | null> => {
  try {
    const resolved = await secrets.resolve({ scope, name });
    // Where the key came from is the first thing to check if it might have
    // leaked, so it is said on every start.
    say(`${scope} ${name} from ${resolved.source} (${resolved.protection})`);
    return resolved.value;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/not found|no source/i.test(message)) say(`could not read ${scope} ${name}: ${message}`);
    return null;
  }
};
const read = (name: string) => readSecret("hedera", name);

/** The Ledger as a human approver: its address, and a way to ask it. */
async function ledgerApprover(): Promise<HumanApprover> {
  // Imported only when asked for, so a machine without the device packages
  // still runs every other tool.
  const { LedgerDevice, DeviceConfirmation } = await import("@presign/ledger");
  const device = await LedgerDevice.connect({ discoveryTimeoutMs: 8_000 });
  const confirmation = new DeviceConfirmation({
    device,
    onProgress: (step) => say(`device: ${step}`),
  });
  const address = (await confirmation.address()) as `0x${string}`;
  return {
    address,
    request: (signable, verdict) =>
      confirmation.request(signable as never, verdict as never) as never,
  };
}

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

/*
 * The signing broker, when the agent has an Ethereum key.
 *
 * With it the model can ask for a signature, and every signature runs through
 * a verdict on the exact transaction. Without it there is no signing tool at
 * all — offering one that could only refuse would teach the model to go
 * looking for a key elsewhere.
 */
let broker: VerdictServerConfig["broker"] = null;
const evmKey = await readSecret("ethereum", "agent-key");
if (evmKey !== null) {
  try {
    // A verdict fetched over plain HTTP is a verdict anyone on the path can
    // rewrite to `low`. Local development is the only exception.
    const service = new URL(baseUrl);
    const local = service.hostname === "localhost" || service.hostname === "127.0.0.1";
    if (service.protocol !== "https:" && !local) {
      throw new Error(`PRESIGN_URL must be https to sign on its verdicts, not ${service.protocol}`);
    }

    const hex = (evmKey.startsWith("0x") ? evmKey : `0x${evmKey}`) as `0x${string}`;
    const account = privateKeyToAccount(hex);
    const rpcUrl =
      process.env["ETH_RPC_URL"] ??
      (await readSecret("ethereum", "rpc-url")) ??
      "https://ethereum-rpc.publicnode.com";

    const policy: BrokerPolicy = {
      allowedRecipients: new Set(
        (process.env["PRESIGN_BROKER_ALLOW"] ?? "")
          .split(",")
          .map((address) => address.trim().toLowerCase())
          .filter((address) => /^0x[0-9a-f]{40}$/.test(address)),
      ),
      maxEthPerTransactionWei: parseEther(process.env["PRESIGN_BROKER_MAX_ETH_PER_TX"] ?? formatEther(DEFAULT_BROKER_POLICY.maxEthPerTransactionWei)),
      maxEthPerSessionWei: parseEther(process.env["PRESIGN_BROKER_MAX_ETH_PER_SESSION"] ?? formatEther(DEFAULT_BROKER_POLICY.maxEthPerSessionWei)),
      maxFeeWei: parseEther(process.env["PRESIGN_BROKER_MAX_FEE_ETH"] ?? formatEther(DEFAULT_BROKER_POLICY.maxFeeWei)),
      maxPriorityFeePerGasWei: parseGwei(process.env["PRESIGN_BROKER_MAX_PRIORITY_GWEI"] ?? formatGwei(DEFAULT_BROKER_POLICY.maxPriorityFeePerGasWei)),
    };

    const approver = process.env["PRESIGN_LEDGER"] === "1" ? await ledgerApprover() : null;
    broker = { account, chain: rpcChainReader(rpcUrl), approver, policy };
    say(
      `sign_transaction signs as ${account.address}; ${policy.allowedRecipients.size} allowlisted recipient(s), ` +
        `${formatEther(policy.maxEthPerTransactionWei)} ETH per transaction and ` +
        `${formatEther(policy.maxEthPerSessionWei)} ETH per session without a human; ` +
        (approver === null
          ? "medium verdicts are refused, no device attached (PRESIGN_LEDGER=1 attaches one)"
          : `medium verdicts need the Ledger at ${approver.address}`),
    );
  } catch (error) {
    say(`signing broker unavailable — ${error instanceof Error ? error.message : String(error)}`);
  }
}

const server = createVerdictServer({ baseUrl, payer, setupHint, broker });
await server.connect(new StdioServerTransport());
say(`ready on stdio, verdicts from ${baseUrl}`);
