/**
 * Minimal MCP client for the subgraph registry, over stdio.
 *
 * The registry ships as an MCP server, so this process is a client of it. Three
 * message shapes are the whole protocol; a client SDK would add a dependency
 * without removing code.
 *
 * Extracted from the wiring because the coverage sweep needs a registry
 * without needing a fork, an anvil or a verdict engine — and building one just
 * to ask which deployments conform would take a minute to start and cost an
 * archive RPC for nothing.
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

/**
 * How long a registry call may take before it is treated as a failure.
 *
 * Without this a dead subprocess is indistinguishable from a slow one: the
 * promise for its reply is never settled by anything, so a caller waits for a
 * process that will never answer. Observed exactly once and it cost an hour —
 * a run that had finished its work sat in `ep_poll` with no children, no
 * output and no error, looking like a hang in code that had already done its
 * job.
 *
 * Fifteen seconds is generous for a local subprocess answering from its own
 * cache, and short enough that a service refuses a verdict rather than holding
 * a connection open until the caller gives up.
 */
const REGISTRY_TIMEOUT_MS = 15_000;

import type { RegistryToolCaller } from "@presign/operational-layer";

export class RegistrySubprocess implements RegistryToolCaller {
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

  /**
   * Send one JSON-RPC message and wait for its reply.
   *
   * Rejects on timeout rather than resolving with nothing, because the two
   * mean different things to every caller above: a rule that gets `undefined`
   * reports "nothing indexes this contract", which is a claim about the chain,
   * while a rejection reports that we could not ask — and only the second is
   * allowed to become `unavailable` instead of a clean verdict.
   */
  #send(method: string, params?: unknown): Promise<unknown> {
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`registry did not answer ${method} within ${REGISTRY_TIMEOUT_MS}ms`));
      }, REGISTRY_TIMEOUT_MS);
      // `unref` so a pending call cannot by itself keep the process alive.
      timer.unref?.();

      this.#pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
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

/** The registry as an npx subprocess, which is how it is distributed. */
export function buildRegistry(): RegistrySubprocess {
  return new RegistrySubprocess();
}
