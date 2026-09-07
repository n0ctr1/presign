/**
 * Assembles every layer into a working pipeline.
 *
 * Kept apart from the scenario script so this file reads as the answer to
 * "what does a deployment actually need", which is the question a reviewer
 * reproducing the project asks first.
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

import {
  ConformanceProbe,
  GatewayClient,
  JsonRpcChainHeadSource,
  LivenessProbe,
  SubgraphRegistrySource,
  type RegistryToolCaller,
} from "@presign/operational-layer";
import {
  EnvSecretSource,
  FileSecretSource,
  SecretResolver,
} from "@presign/secrets";
import { ProxyUpgradeIndex } from "@presign/substreams";
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


/** Minimal MCP client over stdio: three message shapes, no SDK needed. */
class RegistrySubprocess implements RegistryToolCaller {
  readonly #child: ChildProcessByStdio<Writable, Readable, null>;
  readonly #pending = new Map<number, (message: unknown) => void>();
  #buffer = "";
  #nextId = 0;
  readonly #ready: Promise<void>;

  constructor() {
    this.#child = spawn("npx", ["-y", "subgraph-registry-mcp"], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    this.#child.stdout.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk: string) => {
      this.#buffer += chunk;
      for (;;) {
        const newline = this.#buffer.indexOf("\n");
        if (newline < 0) break;
        const line = this.#buffer.slice(0, newline).trim();
        this.#buffer = this.#buffer.slice(newline + 1);
        if (line === "") continue;
        try {
          const message = JSON.parse(line) as { id?: number };
          if (typeof message.id === "number") {
            this.#pending.get(message.id)?.(message);
            this.#pending.delete(message.id);
          }
        } catch {
          // The registry writes progress lines alongside JSON-RPC frames.
        }
      }
    });
    this.#ready = this.#handshake();
  }

  #send(method: string, params?: unknown): Promise<unknown> {
    const id = ++this.#nextId;
    return new Promise((resolve) => {
      this.#pending.set(id, resolve);
      this.#child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  }

  async #handshake(): Promise<void> {
    await this.#send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "presign-demo", version: "0.0.1" },
    });
    this.#child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.#ready;
    const response = (await this.#send("tools/call", {
      name,
      arguments: args,
    })) as { result?: unknown };
    return response.result;
  }

  close(): void {
    this.#child.kill();
  }
}

export interface Wiring {
  readonly engine: VerdictEngine;
  readonly strictEngine: VerdictEngine;
  readonly forkBlock: number;
  readonly close: () => void;
}

/**
 * @param maxLagSeconds freshness budget for the strict engine, used to show
 *   that the same transaction becomes `unavailable` when nothing is fresh
 *   enough.
 */
export async function buildWiring(strictLagSeconds = 1): Promise<Wiring> {
  const secrets = new SecretResolver([
    new FileSecretSource(join(homedir(), ".presign", "secrets")),
    new EnvSecretSource(),
  ]);

  const gateway = new GatewayClient({
    apiKey: async () =>
      (await secrets.resolve({ scope: "the-graph", name: "studio-api-key" })).value,
  });

  // Resolved before anything that needs it: both the fork and the chain-head
  // source read from the same upstream.
  const rpc = await resolveEthereumRpc();
  console.log(`Fork upstream: ${describeRpc(rpc)}`);

  const registry = new RegistrySubprocess();
  const discovery = new SubgraphRegistrySource(registry);
  const conformance = new ConformanceProbe({ gateway });
  const liveness = new LivenessProbe({
    gateway,
    chainHead: new JsonRpcChainHeadSource({ endpoints: { mainnet: rpc.url } }),
  });

  const protocol = new OperationalProtocolContext({
    discovery,
    conformance,
    liveness,
    gateway,
  });

  const fork = await AnvilFork.start({ forkUrl: rpc.url, port: 8545 });
  const simulator = new ForkSimulator(fork.rpcUrl);
  const forkBlock = (await simulator.simulate({
    from: "0x0000000000000000000000000000000000000001",
    to: null,
    value: 0n,
    data: "0x",
    chainId: 1,
  })).blockNumber;

  /*
   * Proxy upgrade history, started in the background when a key is present.
   *
   * Not awaited: a backfill takes a minute or two, and the demo should print
   * verdicts rather than a progress bar. R2 reports the history as unavailable
   * until the stream is live, which is the honest answer while it is filling.
   */
  let upgrades: ProxyUpgradeIndex | undefined;
  try {
    const substreamsKey = (
      await readFile(join(homedir(), ".presign", "secrets", "substreams__api-key"), "utf8")
    ).trim();
    upgrades = ProxyUpgradeIndex.create({ apiKey: substreamsKey, startBlock: -600 });
    void upgrades.run().catch(() => {
      // R2 will report the history as unavailable; nothing else to do here.
    });
    console.log("Proxy upgrade stream: started");
  } catch {
    console.log("Proxy upgrade stream: no Substreams key, R2 runs without upgrade history");
  }

  const rules = (maxLagSeconds?: number) => [
    // The spender used by the high-risk scenario, standing in for an incident
    // registry entry.
    new UnlimitedApprovalRule({
      incidentRegistry: ["0x00000000000000000000000000000000deadbeef"],
    }),
    new MutableLogicRule(upgrades === undefined ? {} : { upgradeHistory: upgrades }),
    new InvariantBreachRule({
      protocol,
      ...(maxLagSeconds === undefined ? {} : { maxLagSeconds }),
    }),
  ];

  return {
    engine: new VerdictEngine({ simulator, rules: rules() }),
    strictEngine: new VerdictEngine({
      simulator,
      rules: rules(strictLagSeconds),
    }),
    forkBlock,
    close: () => {
      upgrades?.stop();
      registry.close();
      fork.stop();
    },
  };
}
