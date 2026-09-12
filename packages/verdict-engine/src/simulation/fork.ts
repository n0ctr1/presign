/**
 * Anvil fork lifecycle.
 *
 * Kept separate from the simulator because a long-lived gateway should hold
 * one warm fork across many verdicts rather than paying process startup per
 * signature. The simulator only needs an RPC URL and does not care who owns
 * the process behind it.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

export interface AnvilForkOptions {
  /** Upstream RPC the fork is taken from. */
  readonly forkUrl: string;
  /**
   * Port to listen on. Omit for one the OS says is free.
   *
   * A fixed default was a hazard rather than a convenience: if something else
   * already held 8545, the readiness loop could be answered by that node and
   * every verdict would then be simulated against a chain this process does
   * not control, while reporting its own fork block.
   */
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
    const port = options.port ?? (await freePort());
    if (await answersRpc(port)) {
      throw new AnvilStartupError(
        `something already answers JSON-RPC on port ${port}; simulating against ` +
          "another node's state would produce verdicts about a chain this process does not own",
      );
    }
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

    // A binary that is missing or not executable emits `error`, never `exit`,
    // so without this the loop below waits out its whole timeout and reports
    // "not ready" for what is really "anvil is not installed".
    const failure: { error: Error | null } = { error: null };
    child.on("error", (error: Error) => {
      failure.error = error;
    });

    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const fork = new AnvilFork(child, port);
    const deadline = Date.now() + (options.startupTimeoutMs ?? 60_000);

    while (Date.now() < deadline) {
      if (failure.error !== null) throw new AnvilStartupError(failure.error.message);
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

/** A port the OS reports free, taken by binding and releasing it. */
async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => {
        if (port === 0) reject(new Error("no free port"));
        else resolve(port);
      });
    });
  });
}

/** Whether something already answers JSON-RPC there. */
async function answersRpc(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(500),
    });
    return response.ok;
  } catch {
    return false;
  }
}
