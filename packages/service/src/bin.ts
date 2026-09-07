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
  describeRpc,
  ForkSimulator,
  InvariantBreachRule,
  MutableLogicRule,
  OperationalProtocolContext,
  resolveEthereumRpc,
  UnlimitedApprovalRule,
  VerdictEngine,
} from "@presign/verdict-engine";

import { buildRegistryClient } from "./registry.js";

import { ProxyUpgradeIndex } from "@presign/substreams";

import { createApp, type HederaNetwork } from "./app.js";
import { readTopicId, writeTopicId } from "./state.js";

const SECRETS = join(homedir(), ".presign", "secrets");
const readSecret = async (name: string) =>
  (await readFile(join(SECRETS, name), "utf8")).trim();


async function main(): Promise<void> {
  const network = (process.env["HEDERA_NETWORK"] ?? "hedera:testnet") as HederaNetwork;
  const short = network === "hedera:mainnet" ? "mainnet" : "testnet";
  const port = Number(process.env["PORT"] ?? 4021);
  /*
   * Bind address, explicit rather than implicit.
   *
   * @hono/node-server defaults to `::`, so the service listens on every
   * interface whether or not that was intended — and the startup line used to
   * print 127.0.0.1 regardless, which says the opposite of what is happening.
   * A payment-gated service should state its exposure and let an operator
   * narrow it.
   */
  const host = process.env["HOST"] ?? "0.0.0.0";

  const operatorId = await readSecret(`hedera__${short}-service-id`);
  const operatorKey = await readSecret(`hedera__${short}-service-key`);

  console.log(`Opening HCS journal on ${short}…`);
  // Environment first for a deliberate override, then the remembered topic.
  // Creating a new one on every restart would scatter the journal across
  // topics, and a journal in fragments is not a track record.
  const knownTopic = process.env["HCS_TOPIC_ID"] ?? (await readTopicId(short));
  const journal = await HcsVerdictJournal.open({
    network: short,
    operatorId,
    operatorKey,
    ...(knownTopic === null ? {} : { topicId: knownTopic }),
  });
  if (knownTopic === null) await writeTopicId(short, journal.topicId);
  console.log(
    `  topic ${journal.topicId} (${knownTopic === null ? "created" : "reused"}) — ${journal.explorerUrl}`,
  );

  const rpc = await resolveEthereumRpc();
  console.log(`Starting mainnet fork for simulation — ${describeRpc(rpc)}`);
  if (!rpc.archiveCapable) {
    // Said once, loudly, at startup rather than discovered as a 503 by whoever
    // paid for the verdict that could not be produced.
    console.log(
      "  WARNING: the public endpoint refuses archive reads, so simulation " +
        "against a protocol contract will fail once the fork block ages. " +
        `Put an archive URL in ~/.presign/secrets/ethereum__rpc-url.`,
    );
  }
  const fork = await AnvilFork.start({ forkUrl: rpc.url, port: 8545 });
  const simulator = new ForkSimulator(fork.rpcUrl);

  /*
   * Proxy upgrade history, when a Substreams key is available.
   *
   * Started in the background and deliberately not awaited: backfilling takes
   * a minute or two, and blocking start-up on it would trade a working service
   * for a slightly better-informed one. R2 reads the index as it fills, and
   * reports the history as unavailable while the stream is not yet live —
   * which is honest, since an index that has seen nothing has nothing to say.
   */
  let upgrades: ProxyUpgradeIndex | undefined;
  try {
    const substreamsKey = await readSecret("substreams__api-key");
    upgrades = ProxyUpgradeIndex.create({
      apiKey: substreamsKey,
      startBlock: -2000,
    });
    void upgrades.run().catch((error: unknown) => {
      // Logged, not swallowed. A dead stream makes R2 report the history as
      // unavailable rather than clean, but an operator still needs to know.
      console.error(
        `  upgrade stream stopped: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    console.log("  proxy upgrade stream started (backfilling ~2000 blocks)");
  } catch {
    console.log(
      "  no Substreams key — R2 runs without upgrade history " +
        "(it will report the history as unavailable rather than clean)",
    );
  }

  const rules = () => [
    new UnlimitedApprovalRule(),
    new MutableLogicRule(upgrades === undefined ? {} : { upgradeHistory: upgrades }),
  ];
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
        chainHead: new JsonRpcChainHeadSource({ endpoints: { mainnet: rpc.url } }),
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
    sources: () =>
      upgrades === undefined
        ? []
        : [
            {
              name: "proxy-upgrade-stream",
              live: upgrades.live,
              detail: {
                ...upgrades.stats,
                ...(upgrades.failure === null ? {} : { failure: upgrades.failure }),
              },
            },
          ],
    journal,
    payTo: operatorId,
    network,
  });

  serve({ fetch: app.fetch, port, hostname: host }, (info) => {
    const reachable =
      info.address === "::" || info.address === "0.0.0.0"
        ? "all interfaces"
        : info.address;
    console.log(`\npresign service listening on port ${info.port} (${reachable})`);
    console.log(`  network:     ${network}`);
    console.log(`  pay to:      ${operatorId}`);
    console.log(`  quote:       GET  /quote`);
    console.log(
      `  paid routes: POST /verdict/local${full === undefined ? "" : ", POST /verdict/full"}`,
    );
  });

  const shutdown = () => {
    upgrades?.stop();
    closeRegistry?.();
    fork.stop();
    journal.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

await main();
