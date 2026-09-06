/**
 * Anvil fork lifecycle.
 *
 * Kept separate from the simulator because a long-lived gateway should hold
 * one warm fork across many verdicts rather than paying process startup per
 * signature. The simulator only needs an RPC URL and does not care who owns
 * the process behind it.
 */

import { spawn, type ChildProcess } from "node:child_process";

export interface AnvilForkOptions {
  /** Upstream RPC the fork is taken from. */
  readonly forkUrl: string;
  readonly port?: number;
  /** Pin the fork to a block, so a verdict is reproducible after the fact. */
  readonly forkBlockNumber?: number;
  readonly binary?: string;
  readonly startupTimeoutMs?: number;
}

export class AnvilStartupError extends Error {
  constructor(message: string) {
    super(`anvil fork failed to start: ${message}`);
    this.name = "AnvilStartupError";
  }
}

export class AnvilFork {
  readonly rpcUrl: string;
  readonly #child: ChildProcess;

  private constructor(child: ChildProcess, port: number) {
    this.#child = child;
    this.rpcUrl = `http://127.0.0.1:${port}`;
  }

  static async start(options: AnvilForkOptions): Promise<AnvilFork> {
    const port = options.port ?? 8545;
    const args = [
      "--fork-url",
      options.forkUrl,
      "--port",
      String(port),
      "--silent",
      // No mining timer: the fork must stay at a fixed block while a
      // transaction is evaluated against it, or the state under the verdict
      // moves while the verdict is being formed.
      "--no-mining",
    ];
    if (options.forkBlockNumber !== undefined) {
      args.push("--fork-block-number", String(options.forkBlockNumber));
    }

    const child = spawn(options.binary ?? "anvil", args, {
      stdio: ["ignore", "ignore", "pipe"],
    });

    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const fork = new AnvilFork(child, port);
    const deadline = Date.now() + (options.startupTimeoutMs ?? 60_000);

    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new AnvilStartupError(stderr.trim() || `exited ${child.exitCode}`);
      }
      try {
        const response = await fetch(fork.rpcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "eth_blockNumber",
            params: [],
          }),
          signal: AbortSignal.timeout(1_000),
        });
        if (response.ok) return fork;
      } catch {
        // Not listening yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    child.kill();
    throw new AnvilStartupError(
      `not ready within timeout${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
    );
  }

  stop(): void {
    this.#child.kill();
  }
}
