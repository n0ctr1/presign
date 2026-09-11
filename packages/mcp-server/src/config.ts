/**
 * Wires the operational layer from environment configuration.
 *
 * Kept apart from the server definition so the tools can be exercised against
 * injected fakes, and so the credential path is visible in one place rather
 * than scattered through tool handlers.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { ProxyUpgradeIndex } from "@presign/substreams";
import {
  CapabilityIndex,
  ConformanceProbe,
  GatewayClient,
  JsonRpcChainHeadSource,
  LivenessProbe,
  REGISTRY_PACKAGE,
  RegistrySubprocess,
  SubgraphRegistrySource,
} from "@presign/operational-layer";
import {
  EnvSecretSource,
  FileSecretSource,
  SecretResolver,
  type SecretRef,
} from "@presign/secrets";

const STUDIO_KEY: SecretRef = { scope: "the-graph", name: "studio-api-key" };
const SUBSTREAMS_KEY: SecretRef = { scope: "substreams", name: "api-key" };

/**
 * Default RPC endpoints, used only for chain head.
 *
 * Public endpoints are fine for reading a block header and deliberately carry
 * no credentials: chain head is the one input we must be able to obtain
 * independently of the indexer, so it should not share a failure domain with
 * anything else we authenticate to.
 */
const DEFAULT_RPC_ENDPOINTS: Readonly<Record<string, string>> = {
  mainnet: "https://ethereum-rpc.publicnode.com",
  base: "https://base-rpc.publicnode.com",
  "arbitrum-one": "https://arbitrum-one-rpc.publicnode.com",
  optimism: "https://optimism-rpc.publicnode.com",
  matic: "https://polygon-bor-rpc.publicnode.com",
};

export interface ServerConfig {
  readonly index: CapabilityIndex;
  readonly discovery: SubgraphRegistrySource;
  readonly liveness: LivenessProbe;
  readonly conformance: ConformanceProbe;
  /**
   * Proxy upgrade history, when a Substreams key is configured.
   *
   * Optional because the rest of the server needs only a Studio key, and an
   * installation without a Substreams key should still answer every freshness
   * question rather than fail to start. Absent here means the two
   * upgrade-history tools are not registered at all.
   */
  readonly upgrades?: ProxyUpgradeIndex;
  /** Called on shutdown to release the registry subprocess and the stream. */
  readonly close: () => void;
}

export interface BuildConfigOptions {
  readonly registryCommand?: string;
  readonly registryArgs?: readonly string[];
  readonly rpcEndpoints?: Readonly<Record<string, string>>;
  readonly maxCandidates?: number;
  readonly secretsDir?: string;
  /**
   * How far back the upgrade stream backfills on start, in blocks.
   *
   * Negative is relative to chain head. Two thousand blocks is about seven
   * hours of mainnet: long enough that the first answers are useful, short
   * enough that the backfill finishes in a couple of minutes.
   */
  readonly upgradeStartBlock?: number;
}

/**
 * Async because the Substreams key has to be *resolved* before the stream can
 * be constructed, unlike the gateway key which is fetched per request. The
 * alternative — constructing an index that discovers at first use that it has
 * no key — would put the failure somewhere a caller reads as "no upgrades".
 */
export async function buildConfig(
  options: BuildConfigOptions = {},
): Promise<ServerConfig> {
  // File first, then environment. A Ledger Key Ring source slots in ahead of
  // both without any change here, which is why the order is a list rather
  // than a lookup.
  const secrets = new SecretResolver([
    new FileSecretSource(
      options.secretsDir ?? join(homedir(), ".presign", "secrets"),
    ),
    new EnvSecretSource(),
  ]);

  const gateway = new GatewayClient({
    apiKey: async () => (await secrets.resolve(STUDIO_KEY)).value,
  });

  // The shared client: pinned package, restarted after a crash, and started
  // with none of this server's credentials except the Studio key.
  const registry = new RegistrySubprocess({
    command: options.registryCommand ?? "npx",
    args: options.registryArgs ?? ["-y", REGISTRY_PACKAGE],
    clientName: "presign",
  });

  const discovery = new SubgraphRegistrySource(registry);
  const conformance = new ConformanceProbe({ gateway });
  const liveness = new LivenessProbe({
    gateway,
    chainHead: new JsonRpcChainHeadSource({
      endpoints: options.rpcEndpoints ?? DEFAULT_RPC_ENDPOINTS,
    }),
  });

  const index = new CapabilityIndex({
    discovery,
    conformance,
    liveness,
    // Wider than the library default. Conforming deployments sit below
    // non-conforming ones in the reliability ranking — measured on mainnet
    // lending, all five that answer R3 rank beneath five that do not — so a
    // narrow probe window returns nothing while good candidates sit just
    // outside it.
    maxCandidates: options.maxCandidates ?? 20,
  });

  /*
   * The upgrade stream, when a key is available.
   *
   * Deliberately not awaited: a backfill takes a minute or two, and blocking
   * start-up on it would leave every other tool unanswerable meanwhile. Until
   * it goes live the two history tools report `source.live: false`, which the
   * response tells the caller to read as "no information", not as "no
   * upgrades". Failures land on `failure` rather than stderr, because stdout
   * is the transport here and a caller needs the reason in the answer.
   */
  let upgrades: ProxyUpgradeIndex | undefined;
  try {
    const key = (await secrets.resolve(SUBSTREAMS_KEY)).value;
    upgrades = ProxyUpgradeIndex.create({
      apiKey: key,
      startBlock: options.upgradeStartBlock ?? -2000,
    });
    void upgrades.run().catch(() => {
      // The index records why it stopped; `live` goes false either way.
    });
  } catch {
    // No key: the history tools are not registered, and every other tool
    // works exactly as before.
  }

  return {
    index,
    discovery,
    liveness,
    conformance,
    ...(upgrades === undefined ? {} : { upgrades }),
    close: () => {
      upgrades?.stop();
      registry.close();
    },
  };
}
