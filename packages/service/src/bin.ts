#!/usr/bin/env node
/**
 * Runs the x402-gated verdict service.
 *
 *   npm run start -w @presign/service
 *
 * Reads Hedera credentials from ~/.presign/secrets, opens (or reuses) an HCS
 * topic for the journal, starts a mainnet fork for simulation, and listens.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { serve } from "@hono/node-server";
import { PresignPipeline } from "@presign/gateway";
import { HcsVerdictJournal } from "@presign/hedera";
import {
  ConformanceProbe,
  GatewayClient,
  JsonRpcChainHeadSource,
  LivenessProbe,
  SubgraphRegistrySource,
} from "@presign/operational-layer";
import {
  AnvilFork,
  ForkSimulator,
  InvariantBreachRule,
  MutableLogicRule,
  OperationalProtocolContext,
  UnlimitedApprovalRule,
  VerdictEngine,
} from "@presign/verdict-engine";

import { buildRegistryClient } from "./registry.js";

import { createApp, type HederaNetwork } from "./app.js";

const SECRETS = join(homedir(), ".presign", "secrets");
const readSecret = async (name: string) =>
  (await readFile(join(SECRETS, name), "utf8")).trim();

const MAINNET_RPC = "https://ethereum-rpc.publicnode.com";

async function main(): Promise<void> {
  const network = (process.env["HEDERA_NETWORK"] ?? "hedera:testnet") as HederaNetwork;
  const short = network === "hedera:mainnet" ? "mainnet" : "testnet";
  const port = Number(process.env["PORT"] ?? 4021);

  const operatorId = await readSecret(`hedera__${short}-service-id`);
  const operatorKey = await readSecret(`hedera__${short}-service-key`);

  console.log(`Opening HCS journal on ${short}…`);
  const journal = await HcsVerdictJournal.open({
    network: short,
    operatorId,
    operatorKey,
    ...(process.env["HCS_TOPIC_ID"] === undefined
      ? {}
      : { topicId: process.env["HCS_TOPIC_ID"] }),
  });
  console.log(`  topic ${journal.topicId} — ${journal.explorerUrl}`);

  console.log("Starting mainnet fork for simulation…");
  const fork = await AnvilFork.start({ forkUrl: MAINNET_RPC, port: 8545 });
  const simulator = new ForkSimulator(fork.rpcUrl);

  const rules = () => [new UnlimitedApprovalRule(), new MutableLogicRule()];
  const local = new PresignPipeline({
    engine: new VerdictEngine({ simulator, rules: rules() }),
  });

  /*
   * The dearer route exists only if R3 can actually run.
   *
   * R3 needs a Subgraph Studio key and the registry subprocess. Without them
   * the process cannot produce the verdict `/verdict/full` charges for, so the
   * route is not offered at all rather than sold and under-delivered. An
   * earlier version always exposed it while running R1 and R2 alone, charging
   * five times the price for the cheaper verdict.
   */
  let full: PresignPipeline | undefined;
  let closeRegistry: (() => void) | undefined;
  try {
    const studioKey = await readSecret("the-graph__studio-api-key");
    const gateway = new GatewayClient({ apiKey: () => Promise.resolve(studioKey) });
    const registry = buildRegistryClient();
    closeRegistry = registry.close;
    const discovery = new SubgraphRegistrySource(registry);
    const protocol = new OperationalProtocolContext({
      discovery,
      conformance: new ConformanceProbe({ gateway }),
      liveness: new LivenessProbe({
        gateway,
        chainHead: new JsonRpcChainHeadSource({ endpoints: { mainnet: MAINNET_RPC } }),
      }),
      gateway,
    });
    full = new PresignPipeline({
      engine: new VerdictEngine({
        simulator,
        rules: [...rules(), new InvariantBreachRule({ protocol })],
      }),
    });
    console.log("  R3 enabled — /verdict/full is offered");
  } catch (error) {
    console.log(
      `  R3 disabled — /verdict/full is NOT offered (${error instanceof Error ? error.message : String(error)})`,
    );
  }

  const app = createApp({
    pipelines: full === undefined ? { local } : { local, full },
    journal,
    payTo: operatorId,
    network,
  });

  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`\npresign service listening on http://127.0.0.1:${info.port}`);
    console.log(`  network:     ${network}`);
    console.log(`  pay to:      ${operatorId}`);
    console.log(`  quote:       GET  /quote`);
    console.log(
      `  paid routes: POST /verdict/local${full === undefined ? "" : ", POST /verdict/full"}`,
    );
  });

  const shutdown = () => {
    closeRegistry?.();
    fork.stop();
    journal.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

await main();
