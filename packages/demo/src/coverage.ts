/**
 * Breadth, counted rather than claimed.
 *
 * The argument for binding rules to schema families instead of to protocols is
 * a coverage argument: one rule, one standard schema, every protocol that
 * speaks it — with no per-protocol code. That argument is only worth making
 * with a number attached, and the number this project had covered one family
 * on one network, measured once.
 *
 * So this sweeps every family the rules can read against every network the
 * engine maps, and reports what actually conforms. It is deliberately a
 * measurement and not a test: coverage moves as people publish and unpublish
 * subgraphs, and a fixed expectation would fail for reasons that have nothing
 * to do with this code.
 *
 * It is also the honest version of the demo's "add a protocol in one line".
 * Nothing has to be added for a new protocol inside a family the rules already
 * read — it is covered the moment somebody indexes it with the standard
 * schema. What costs a line is a new *family*, and the rows below are what
 * each of those lines bought.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import {
  CapabilityIndex,
  ConformanceProbe,
  GatewayClient,
  JsonRpcChainHeadSource,
  LivenessProbe,
  RULE_REQUIREMENTS,
  SubgraphRegistrySource,
  chooseFunding,
  PaymentLedger,
  effectiveLagSeconds,
  type NetworkId,
} from "@presign/operational-layer";
import { EnvSecretSource, FileSecretSource, SecretResolver } from "@presign/secrets";
import { resolveEthereumRpc, CHAIN_TO_NETWORK } from "@presign/verdict-engine";

import { buildRegistry } from "./registry-client.js";

async function main(): Promise<void> {
  const secrets = new SecretResolver([
    new FileSecretSource(join(homedir(), ".presign", "secrets")),
    new EnvSecretSource(),
  ]);
  const read = async (scope: string, name: string) => {
    try {
      return (await secrets.resolve({ scope, name })).value;
    } catch {
      return null;
    }
  };

  const rpc = await resolveEthereumRpc();
  const funding = chooseFunding({
    studioKey: await read("the-graph", "studio-api-key"),
    payerKey: await read("base", "payer-key"),
    ledger: new PaymentLedger(),
  });
  const gateway = new GatewayClient({ funding: funding.funding });

  const registry = buildRegistry();
  const index = new CapabilityIndex({
    discovery: new SubgraphRegistrySource(registry),
    conformance: new ConformanceProbe({ gateway }),
    liveness: new LivenessProbe({
      gateway,
      // Chain head per network, independent of the indexer being measured.
      chainHead: new JsonRpcChainHeadSource({
        endpoints: {
          mainnet: rpc.url,
          base: "https://base-rpc.publicnode.com",
          "arbitrum-one": "https://arbitrum-one-rpc.publicnode.com",
          optimism: "https://optimism-rpc.publicnode.com",
          matic: "https://polygon-bor-rpc.publicnode.com",
        } as Record<NetworkId, string>,
      }),
    }),
    maxCandidates: Number(process.env["MAX_CANDIDATES"] ?? 20),
  });

  const networks = [...new Set(Object.values(CHAIN_TO_NETWORK))];
  const line = "─".repeat(78);
  console.log(`${"schema family".padEnd(16)} ${"network".padEnd(14)} ${"conforming".padStart(10)}   deployments`);
  console.log(line);

  let total = 0;
  const families = new Set<string>();

  try {
    for (const requirement of RULE_REQUIREMENTS) {
      for (const network of networks) {
        let conforming = 0;
        let names = "";
        try {
          const resolution = await index.warm(requirement, network);
          if (resolution.satisfied) {
            conforming = resolution.records.length;
            const now = new Date();
            names = resolution.records
              .slice(0, 3)
              .map(
                (r) =>
                  `${r.candidate.displayName} (${effectiveLagSeconds(r, now).toFixed(0)}s)`,
              )
              .join(", ");
            if (resolution.records.length > 3) names += `, +${resolution.records.length - 3} more`;
          } else {
            names = `— ${resolution.reason}`;
          }
        } catch (error) {
          names = `— ${error instanceof Error ? error.message.slice(0, 40) : String(error)}`;
        }

        total += conforming;
        if (conforming > 0) families.add(requirement.schemaFamily);
        console.log(
          `${requirement.schemaFamily.padEnd(16)} ${network.padEnd(14)} ${String(conforming).padStart(10)}   ${names}`,
        );
      }
    }
  } finally {
    registry.close();
  }

  console.log(line);
  console.log(
    `${total} conforming deployment(s) across ${families.size} schema famil(ies) and ${networks.length} networks, ` +
      "reachable by the same rules with no per-protocol code.",
  );
  console.log(`Funding: ${funding.reason}`);

  // The registry subprocess is closed above; exiting explicitly keeps this
  // consistent with the other one-shot harnesses.
  process.exit(0);
}

await main();
