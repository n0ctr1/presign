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

export function buildRegistryClient(): RegistryClient {
  const child: ChildProcessByStdio<Writable, Readable, null> = spawn(
    "npx",
    ["-y", "subgraph-registry-mcp"],
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
    return new Promise((resolve) => {
      pending.set(id, resolve);
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
