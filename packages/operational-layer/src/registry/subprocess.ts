/**
 * The subgraph registry as a child process, spoken to over stdio.
 *
 * The registry ships as an MCP server. The service, the demo and the data-layer
 * MCP server each used to carry their own copy of this client, and the copies
 * drifted: a fix for a dead registry landed in one and not the others. It lives
 * here once.
 *
 * Three failures it exists to survive, each of which used to end the host
 * process rather than one call:
 *
 * - a command that does not exist — `spawn` emits `error`, and an unhandled
 *   `error` event kills Node;
 * - a registry that died — the next write to its stdin raises `EPIPE`;
 * - a handshake nobody waited for timing out — an unhandled rejection.
 *
 * A registry that has failed is restarted on the next call after a short
 * delay, so one crash is a few refused verdicts, not a dead service.
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

import type { RegistryToolCaller } from "./client.js";

/**
 * The registry release this project was verified against. `npx -y` with no
 * version runs whatever was published last, which turns an upstream release
 * into an unreviewed upgrade on the next restart.
 */
export const REGISTRY_PACKAGE = "subgraph-registry-mcp@0.10.1";

/**
 * How long a registry call may take before it is a failure.
 *
 * Without a deadline a dead subprocess is indistinguishable from a slow one,
 * and rejecting rather than resolving with nothing matters as much: a rule
 * handed an empty answer reports "nothing indexes this contract", while a
 * rejection reports that we could not ask — only the second may become
 * `unavailable`.
 */
const DEFAULT_TIMEOUT_MS = 15_000;

/** Replies are one JSON line each; a line that never ends is a fault, not a reply. */
const MAX_LINE_CHARS = 16 * 1024 * 1024;

const DEFAULT_RESTART_DELAY_MS = 5_000;

/**
 * What the registry is allowed to see of this process's environment.
 *
 * `spawn` passes the whole environment by default, and in a container that is
 * every credential the service holds — the Hedera operator key, the RPC URL
 * with its key, the Substreams key. A third-party package needs none of them.
 * It gets what running needs, the Studio key it can use to verify
 * deployments, and its own settings.
 */
const PASSED_THROUGH: readonly RegExp[] = [
  /^PATH$/,
  /^HOME$/,
  /^TMPDIR$/,
  /^TEMP$/,
  /^TMP$/,
  /^LANG$/,
  /^NODE_EXTRA_CA_CERTS$/,
  /^npm_config_/i,
  /^HTTPS?_PROXY$/i,
  /^NO_PROXY$/i,
  /^THE_GRAPH_STUDIO_API_KEY$/,
  /^GRAPH_STUDIO_API_KEY$/,
  /^GATEWAY_API_KEY$/,
  /^GATEWAY_MAX_BODY_BYTES$/,
  /^SUBGRAPH_REGISTRY_/,
];

export function registryEnvironment(
  source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && PASSED_THROUGH.some((pattern) => pattern.test(key))) {
      env[key] = value;
    }
  }
  return env;
}

export interface RegistrySubprocessOptions {
  /** Defaults to `npx`. */
  readonly command?: string;
  /** Defaults to `-y` and the pinned {@link REGISTRY_PACKAGE}. */
  readonly args?: readonly string[];
  /** Sent in the MCP handshake. */
  readonly clientName: string;
  readonly timeoutMs?: number;
  /** How long a failed registry is left alone before the next call restarts it. */
  readonly restartDelayMs?: number;
  /** Defaults to {@link registryEnvironment} of this process. */
  readonly env?: Readonly<Record<string, string>>;
  readonly now?: () => number;
}

type Child = ChildProcessByStdio<Writable, Readable, null>;

interface Waiter {
  readonly resolve: (message: unknown) => void;
  readonly reject: (error: Error) => void;
}

export class RegistrySubprocess implements RegistryToolCaller {
  readonly #command: string;
  readonly #args: readonly string[];
  readonly #clientName: string;
  readonly #timeoutMs: number;
  readonly #restartDelayMs: number;
  readonly #env: Readonly<Record<string, string>>;
  readonly #now: () => number;

  #child: Child | null = null;
  readonly #pending = new Map<number, Waiter>();
  #buffer = "";
  #nextId = 0;
  #ready: Promise<void> = Promise.resolve();
  #failure: { readonly error: Error; readonly at: number } | null = null;
  #closed = false;

  constructor(options: RegistrySubprocessOptions) {
    this.#command = options.command ?? "npx";
    this.#args = options.args ?? ["-y", REGISTRY_PACKAGE];
    this.#clientName = options.clientName;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#restartDelayMs = options.restartDelayMs ?? DEFAULT_RESTART_DELAY_MS;
    this.#env = options.env ?? registryEnvironment();
    this.#now = options.now ?? Date.now;
    this.#start();
  }

  #start(): void {
    this.#failure = null;
    this.#buffer = "";

    const child: Child = spawn(this.#command, [...this.#args], {
      stdio: ["pipe", "pipe", "ignore"],
      env: this.#env,
    });
    this.#child = child;

    child.on("error", (error) => this.#fail(child, error));
    child.on("exit", (code, signal) =>
      this.#fail(child, new Error(`registry exited (${signal ?? `code ${code}`})`)),
    );
    child.stdin.on("error", () => {
      // Surfaces as the exit or error above; unhandled it would kill the host.
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.#onData(child, chunk));

    this.#ready = this.#handshake(child);
    // Callers await `#ready` and see its failure. This only keeps a handshake
    // that fails before anyone calls from becoming an unhandled rejection.
    this.#ready.catch(() => {});
  }

  #fail(child: Child, error: Error): void {
    // A child that has already been replaced reports nothing about the current one.
    if (child !== this.#child || this.#failure !== null) return;
    this.#failure = { error, at: this.#now() };
    this.#buffer = "";
    child.kill();
    for (const waiter of this.#pending.values()) waiter.reject(error);
    this.#pending.clear();
  }

  #onData(child: Child, chunk: string): void {
    if (child !== this.#child || this.#failure !== null) return;
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
          this.#pending.get(message.id)?.resolve(message);
          this.#pending.delete(message.id);
        }
      } catch {
        // The registry writes progress lines alongside JSON-RPC frames.
      }
    }
    if (this.#buffer.length > MAX_LINE_CHARS) {
      this.#fail(child, new Error(`registry wrote a line longer than ${MAX_LINE_CHARS} characters`));
    }
  }

  #send(child: Child, method: string, params?: unknown): Promise<unknown> {
    if (child !== this.#child || this.#failure !== null) {
      return Promise.reject(this.#failure?.error ?? new Error("registry was restarted"));
    }
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`registry did not answer ${method} within ${this.#timeoutMs}ms`));
      }, this.#timeoutMs);
      // Unreffed so one pending call cannot hold the process open by itself.
      timer.unref?.();

      this.#pending.set(id, {
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async #handshake(child: Child): Promise<void> {
    try {
      await this.#send(child, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: this.#clientName, version: "0.0.1" },
      });
    } catch (error) {
      // A registry that cannot finish a handshake is stuck, not slow: stop it
      // so the next call after the delay starts a fresh one.
      this.#fail(child, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (this.#closed) throw new Error("registry client is closed");

    if (this.#failure !== null) {
      const waited = this.#now() - this.#failure.at;
      if (waited < this.#restartDelayMs) {
        throw new Error(
          `registry unavailable (${this.#failure.error.message}); ` +
            `restarting in ${Math.ceil((this.#restartDelayMs - waited) / 1000)}s`,
        );
      }
      // Synchronous, so a second caller arriving now sees the new child.
      this.#start();
    }

    const child = this.#child!;
    await this.#ready;
    const response = (await this.#send(child, "tools/call", { name, arguments: args })) as {
      result?: unknown;
    };
    return response.result;
  }

  close(): void {
    this.#closed = true;
    const child = this.#child;
    if (child !== null) this.#fail(child, new Error("registry client is closed"));
  }
}
