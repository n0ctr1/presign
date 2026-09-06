/**
 * Wires the operational layer from environment configuration.
 *
 * Kept apart from the server definition so the tools can be exercised against
 * injected fakes, and so the credential path is visible in one place rather
 * than scattered through tool handlers.
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { homedir } from "node:os";
import { join } from "node:path";

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
  type SecretRef,
} from "@presign/secrets";

const STUDIO_KEY: SecretRef = { scope: "the-graph", name: "studio-api-key" };

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
  /** Called on shutdown to release the registry subprocess. */
  readonly close: () => void;
}

/**
 * Speaks JSON-RPC to `subgraph-registry-mcp` over stdio.
 *
 * The registry ships as an MCP server, so this process is an MCP client of it
 * while being an MCP server to its own callers. Framing is newline-delimited
 * JSON-RPC, which is the whole protocol here — pulling in a client SDK to send
 * three message shapes would add a dependency without removing any code.
 */
class RegistrySubprocess implements RegistryToolCaller {
  // stderr is "ignore", so it is typed null rather than a stream: the
  // registry logs progress there and we have no use for it.
  readonly #child: ChildProcessByStdio<Writable, Readable, null>;
  readonly #pending = new Map<number, (message: unknown) => void>();
  #buffer = "";
  #nextId = 0;
  #ready: Promise<void>;

  constructor(command: string, args: readonly string[]) {
    this.#child = spawn(command, [...args], {
      stdio: ["pipe", "pipe", "ignore"],
    });

    this.#child.stdout.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk: string) => this.#onData(chunk));

    this.#ready = this.#handshake();
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.length === 0) continue;
      try {
        const message = JSON.parse(line) as { id?: number };
        if (typeof message.id === "number") {
          this.#pending.get(message.id)?.(message);
          this.#pending.delete(message.id);
        }
      } catch {
        // The registry writes progress lines to stdout alongside JSON-RPC.
        // Anything unparseable is not a response we are waiting on.
      }
    }
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
      clientInfo: { name: "presign", version: "0.0.1" },
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

export interface BuildConfigOptions {
  readonly registryCommand?: string;
  readonly registryArgs?: readonly string[];
  readonly rpcEndpoints?: Readonly<Record<string, string>>;
  readonly maxCandidates?: number;
  readonly secretsDir?: string;
}

export function buildConfig(options: BuildConfigOptions = {}): ServerConfig {
  // Hardware first, so a leftover development file cannot shadow a device once
  // one is enrolled. The Ledger Key Ring source lands on day 6 and slots in
  // ahead of these two without any change here.
  const secrets = new SecretResolver([
    new FileSecretSource(
      options.secretsDir ?? join(homedir(), ".presign", "secrets"),
    ),
    new EnvSecretSource(),
  ]);

  const gateway = new GatewayClient({
    apiKey: async () => (await secrets.resolve(STUDIO_KEY)).value,
  });

  const registry = new RegistrySubprocess(
    options.registryCommand ?? "npx",
    options.registryArgs ?? ["-y", "subgraph-registry-mcp"],
  );

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

  return {
    index,
    discovery,
    liveness,
    conformance,
    close: () => registry.close(),
  };
}
