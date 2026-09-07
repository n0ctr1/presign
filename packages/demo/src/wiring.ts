/**
 * Assembles every layer into a working pipeline.
 *
 * Kept apart from the scenario script so this file reads as the answer to
 * "what does a deployment actually need", which is the question a reviewer
 * reproducing the project asks first.
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

import {
  CapabilityIndex,
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
import {
  AnvilFork,
  ForkSimulator,
  InvariantBreachRule,
  MutableLogicRule,
  OperationalProtocolContext,
  UnlimitedApprovalRule,
  VerdictEngine,
} from "@presign/verdict-engine";

const MAINNET_RPC = "https://ethereum-rpc.publicnode.com";

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

  const registry = new RegistrySubprocess();
  const discovery = new SubgraphRegistrySource(registry);
  const conformance = new ConformanceProbe({ gateway });
  const liveness = new LivenessProbe({
    gateway,
    chainHead: new JsonRpcChainHeadSource({ endpoints: { mainnet: MAINNET_RPC } }),
  });

  // Warms candidates ahead of the request path. Not used by R3's
  // counterparty-specific lookup, but part of what a deployment runs.
  void new CapabilityIndex({ discovery, conformance, liveness, maxCandidates: 20 });

  const protocol = new OperationalProtocolContext({
    discovery,
    conformance,
    liveness,
    gateway,
  });

  const fork = await AnvilFork.start({ forkUrl: MAINNET_RPC, port: 8545 });
  const simulator = new ForkSimulator(fork.rpcUrl);
  const forkBlock = (await simulator.simulate({
    from: "0x0000000000000000000000000000000000000001",
    to: null,
    value: 0n,
    data: "0x",
    chainId: 1,
  })).blockNumber;

  const rules = (maxLagSeconds?: number) => [
    // The spender used by the high-risk scenario, standing in for an incident
    // registry entry.
    new UnlimitedApprovalRule({
      incidentRegistry: ["0x00000000000000000000000000000000deadbeef"],
    }),
    new MutableLogicRule(),
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
      registry.close();
      fork.stop();
    },
  };
}
