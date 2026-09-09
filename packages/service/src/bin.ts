#!/usr/bin/env node
/**
 * Runs the x402-gated verdict service.
 *
 *   npm run start -w @presign/service
 *
 * Reads Hedera credentials from ~/.presign/secrets, opens (or reuses) an HCS
 * topic for the journal, starts a mainnet fork for simulation, and listens.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { serve } from "@hono/node-server";
import { PresignPipeline } from "@presign/gateway";
import {
  EnvSecretSource,
  FileSecretSource,
  SecretResolver,
} from "@presign/secrets";
import { HcsVerdictJournal } from "@presign/hedera";
import {
  chooseFunding,
  ConformanceProbe,
  GatewayClient,
  JsonRpcChainHeadSource,
  LivenessProbe,
  PaymentLedger,
  SubgraphRegistrySource,
} from "@presign/operational-layer";
import {
  AnvilFork,
  describeRpc,
  ForkSimulator,
  InvariantBreachRule,
  RpcContractOrigin,
  MutableLogicRule,
  OperationalProtocolContext,
  resolveEthereumRpc,
  UnidentifiedCounterpartyRule,
  UnlimitedApprovalRule,
  VerdictEngine,
} from "@presign/verdict-engine";

import { buildRegistryClient } from "./registry.js";

import { ProxyUpgradeIndex } from "@presign/substreams";

import { createApp, type HederaNetwork } from "./app.js";
import { readTopicId, writeTopicId } from "./state.js";

/**
 * Secrets, through the resolver this project ships rather than around it.
 *
 * The service used to read files directly, which works on a laptop and not in
 * a container, where the only sane way to hand a process a credential is the
 * environment. `SecretResolver` already answers both — file first so a
 * developer's `~/.presign/secrets` wins locally, environment second so a
 * deployment can inject them — and it reports which source answered, which is
 * the whole point of the package. A service that bypasses its own secret
 * handling to call `readFile` is not a good advertisement for it.
 *
 * The `scope__name` file convention maps to `{ scope, name }`, and the
 * environment variable is `SCOPE_NAME` upper-cased, so
 * `the-graph__studio-api-key` is `THE_GRAPH_STUDIO_API_KEY`.
 */
const secrets = new SecretResolver([
  new FileSecretSource(
    process.env["PRESIGN_SECRETS_DIR"] ?? join(homedir(), ".presign", "secrets"),
  ),
  new EnvSecretSource(),
]);

const readSecret = async (fileName: string): Promise<string> => {
  const separator = fileName.indexOf("__");
  if (separator < 0) throw new RangeError(`secret name must be scope__name: ${fileName}`);
  const resolved = await secrets.resolve({
    scope: fileName.slice(0, separator),
    name: fileName.slice(separator + 2),
  });
  return resolved.value;
};


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
  /*
   * The fork re-forks once it falls behind.
   *
   * A demo runs for a minute; this process is meant to run for days, and anvil
   * pins the fork at the block it started on. Without refreshing, every
   * verdict tomorrow would be simulated against today's state while reporting
   * a current lag for its indexed data — declared honestly in provenance and
   * still the exact mismatch this project argues against. Sixty seconds is
   * about five blocks, close enough to head for a pre-signature answer and far
   * enough apart that re-forking is rare.
   */
  const simulator = new ForkSimulator(fork.rpcUrl, {
    maxForkAgeSeconds: Number(process.env["MAX_FORK_AGE_SECONDS"] ?? 60),
    forkUrl: rpc.url,
  });

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
      // Logged when the stream drops. It reconnects on its own from the block
      // after the last one seen, but an operator should still be able to tell
      // a flapping upstream from a quiet one.
      onDisconnect: (reason) =>
        console.error(`  upgrade stream dropped, retrying: ${reason}`),
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

  /*
   * Upstream spend, recorded only when this process actually pays per query.
   *
   * Declared out here because /health and every verdict response report from
   * it, while the funding decision is made below alongside R3's other
   * dependencies. `usingX402` gates whether the ledger is handed to the app at
   * all: an empty ledger on a Studio plan would report a cost of zero, which
   * is false — the cost is real and simply billed elsewhere.
   */
  const ledger = new PaymentLedger();
  let usingX402 = false;

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
    /*
     * How gateway queries are funded.
     *
     * A Studio key is preferred when one exists, because spending real money
     * should be deliberate. `GATEWAY_FUNDING=x402` forces payment; a process
     * with a payer key and no Studio key pays automatically, which is the
     * situation x402 was built for — an agent that needs protocol data and
     * has no human available to mint it a key.
     */
    const choice = chooseFunding({
      studioKey: await readSecret("the-graph__studio-api-key").catch(() => null),
      payerKey: await readSecret("base__payer-key").catch(() => null),
      ledger,
      ...(process.env["GATEWAY_FUNDING"] === "x402"
        ? { prefer: "x402" as const }
        : {}),
    });
    usingX402 = choice.funding.kind === "x402";
    console.log(`  gateway funding: ${choice.reason}`);

    const gateway = new GatewayClient({
      funding: choice.funding,
      // A paid query costs an extra round trip: 402, sign, retry. The keyed
      // default would turn that into a freshness failure on the paid path.
      ...(choice.funding.kind === "x402" ? { timeoutMs: 12_000 } : {}),
    });
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
        rules: [
          ...rules(),
          new InvariantBreachRule({ protocol }),
          // R4 shares the registry adapter R3 already builds. It is scoped to
          // this route for the same reason R3 is: without the registry the
          // process cannot tell an unindexed contract from an unreachable
          // lookup, and guessing between those is the failure the rule exists
          // to prevent.
          new UnidentifiedCounterpartyRule({
            directory: protocol,
            origin: new RpcContractOrigin({ url: rpc.url }),
          }),
        ],
      }),
    });
    console.log("  R3 and R4 enabled — /verdict/full is offered");
  } catch (error) {
    console.log(
      `  R3 and R4 disabled — /verdict/full is NOT offered (${error instanceof Error ? error.message : String(error)})`,
    );
  }

  const app = createApp({
    ...(usingX402 ? { ledger } : {}),
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
