/**
 * Minimal MCP client for the subgraph registry, over stdio.
 *
 * The registry ships as an MCP server, so this process is a client of it while
 * being an x402 server to its own callers. Three message shapes are the whole
 * protocol here; a client SDK would add a dependency without removing code.
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

import type { RegistryToolCaller } from "@presign/operational-layer";

export interface RegistryClient extends RegistryToolCaller {
  close(): void;
}

/**
 * How long a registry call may take before it counts as a failure.
 *
 * Without a deadline a dead subprocess is indistinguishable from a slow one:
 * nothing ever settles the promise for its reply, so the caller waits for a
 * process that will never answer. A paid service must not do that — it holds
 * the caller's connection open while their payment sits in limbo, and no error
 * ever reaches them.
 *
 * Rejecting rather than resolving with nothing matters just as much. A rule
 * handed an empty answer reports "nothing indexes this contract", a claim
 * about the chain; a rejection reports that we could not ask, and only the
 * second is allowed to become `unavailable`.
 */
const REGISTRY_TIMEOUT_MS = 15_000;

export interface RegistryClientOptions {
  /** Executable that speaks the registry's MCP server over stdio. */
  readonly command?: string;
  readonly args?: readonly string[];
}

/**
 * Default to fetching the registry with npx.
 *
 * Right on a developer's machine and wrong in a container, where `npx -y`
 * would reach the network on first use and fail the first verdict rather than
 * the build. An image installs the package and points these at the binary, so
 * the registry is present before anything asks it a question.
 */
const DEFAULT_COMMAND = "npx";
const DEFAULT_ARGS = ["-y", "subgraph-registry-mcp"] as const;

export function buildRegistryClient(
  options: RegistryClientOptions = {},
): RegistryClient {
  const command = options.command ?? process.env["REGISTRY_COMMAND"] ?? DEFAULT_COMMAND;
  const args =
    options.args ??
    (process.env["REGISTRY_ARGS"] === undefined
      ? DEFAULT_ARGS
      : process.env["REGISTRY_ARGS"].split(" ").filter((a) => a !== ""));

  const child: ChildProcessByStdio<Writable, Readable, null> = spawn(
    command,
    [...args],
    { stdio: ["pipe", "pipe", "ignore"] },
  );
  child.stdout.setEncoding("utf8");

  const pending = new Map<number, (message: unknown) => void>();
  let buffer = "";
  let nextId = 0;

  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line === "") continue;
      try {
        const message = JSON.parse(line) as { id?: number };
        if (typeof message.id === "number") {
          pending.get(message.id)?.(message);
          pending.delete(message.id);
        }
      } catch {
        // The registry writes progress lines alongside JSON-RPC frames.
      }
    }
  });

  const send = (method: string, params?: unknown): Promise<unknown> => {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          new Error(`registry did not answer ${method} within ${REGISTRY_TIMEOUT_MS}ms`),
        );
      }, REGISTRY_TIMEOUT_MS);
      // Unreffed so one pending call cannot hold the process open by itself.
      timer.unref?.();

      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  };

  const ready = (async () => {
    await send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "presign-service", version: "0.0.1" },
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
  })();

  return {
    async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
      await ready;
      const response = (await send("tools/call", { name, arguments: args })) as {
        result?: unknown;
      };
      return response.result;
    },
    close: () => child.kill(),
  };
}
