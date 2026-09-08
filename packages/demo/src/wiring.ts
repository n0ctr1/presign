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
  chooseFunding,
  JsonRpcChainHeadSource,
  LivenessProbe,
  PaymentLedger,
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
  RpcContractOrigin,
  UnidentifiedCounterpartyRule,
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
  /** R1 and R2 only: what `/verdict/local` is priced for. */
  readonly localEngine: VerdictEngine;
  readonly forkBlock: number;
  /**
   * Finds a contract deployed shortly before the fork block.
   *
   * R4's scenario cannot use a fixed address: the whole point is a contract
   * too new for anyone to have indexed, and any address hard-coded here would
   * be a week old by the next run and years old by the time anyone reads this.
   * So the demo goes and finds one on the real chain.
   *
   * The search runs *backwards from the fork block*, not from chain head,
   * which is the part that is easy to get wrong. Anvil pins its state at the
   * fork block; a contract created after it does not exist in the fork, and a
   * call to it would simulate as calldata sent to an empty address — a
   * different finding entirely, and one that would make R4 look broken while
   * it was working correctly.
   */
  readonly findRecentDeployment: () => Promise<string | null>;
  /** What queries cost upstream. Empty unless funding is x402. */
  readonly ledger: PaymentLedger;
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

  /*
   * How gateway queries are funded.
   *
   * The Studio key wins when there is one, so `npm run demo` does not spend
   * real money by default. `GATEWAY_FUNDING=x402` pays per query instead, and
   * the demo then prints what each verdict cost upstream — which is the only
   * arrangement under which that number exists at all.
   */
  const ledger = new PaymentLedger();
  const readSecret = async (scope: string, name: string) => {
    try {
      return (await secrets.resolve({ scope, name })).value;
    } catch {
      return null;
    }
  };
  const funding = chooseFunding({
    studioKey: await readSecret("the-graph", "studio-api-key"),
    payerKey: await readSecret("base", "payer-key"),
    ledger,
    ...(process.env["GATEWAY_FUNDING"] === "x402" ? { prefer: "x402" as const } : {}),
  });
  console.log(`Gateway funding: ${funding.reason}`);

  const gateway = new GatewayClient({
    funding: funding.funding,
    // A paid query costs an extra round trip: 402, sign, retry.
    ...(funding.funding.kind === "x402" ? { timeoutMs: 12_000 } : {}),
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

  // Shares the fork's archive endpoint: historical `eth_getCode` is an archive
  // read, and this is the one URL in the process known to serve those.
  const origin = new RpcContractOrigin({ url: rpc.url });

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

  /**
   * The rules that need nothing but an RPC.
   *
   * Split out because the two-sided payment scenario registers both priced
   * routes, and `/verdict/local` must actually be the cheaper verdict. An
   * earlier version of the service offered the dearer route while running
   * these two alone; the mirror of that mistake — charging the base price
   * while running everything — is just as dishonest, and the split makes both
   * impossible here.
   */
  const localRules = () => [
    // The spender used by the high-risk scenario, standing in for an incident
    // registry entry.
    new UnlimitedApprovalRule({
      incidentRegistry: ["0x00000000000000000000000000000000deadbeef"],
    }),
    new MutableLogicRule(upgrades === undefined ? {} : { upgradeHistory: upgrades }),
  ];

  const rules = (maxLagSeconds?: number) => [
    ...localRules(),
    new InvariantBreachRule({
      protocol,
      ...(maxLagSeconds === undefined ? {} : { maxLagSeconds }),
    }),
    // No freshness budget of its own: R4 asks whether anybody has ever indexed
    // the counterparty, not what the indexers say about it now, so the strict
    // engine runs the identical rule and the two engines still differ in
    // exactly one variable.
    new UnidentifiedCounterpartyRule({ directory: protocol, origin }),
  ];

  const findRecentDeployment = async (): Promise<string | null> => {
    const rpcCall = async <T>(method: string, params: unknown[]): Promise<T | null> => {
      const response = await fetch(rpc.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const body = (await response.json()) as { result?: T };
      return body.result ?? null;
    };

    // Forty blocks is roughly eight minutes of mainnet, which has always held
    // a contract creation. Bounded so a quiet chain ends the search rather
    // than the demo.
    for (let block = forkBlock; block > forkBlock - 40; block -= 1) {
      const body = await rpcCall<{
        transactions: readonly { hash: string; to: string | null }[];
      }>("eth_getBlockByNumber", [`0x${block.toString(16)}`, true]);

      for (const transaction of body?.transactions ?? []) {
        if (transaction.to !== null) continue;
        const receipt = await rpcCall<{ contractAddress: string | null }>(
          "eth_getTransactionReceipt",
          [transaction.hash],
        );
        if (typeof receipt?.contractAddress === "string") {
          return receipt.contractAddress;
        }
      }
    }
    return null;
  };

  return {
    engine: new VerdictEngine({ simulator, rules: rules() }),
    localEngine: new VerdictEngine({ simulator, rules: localRules() }),
    findRecentDeployment,
    ledger,
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
