/**
 * Chain head over JSON-RPC.
 *
 * Deliberately independent of the indexer: if both came from the same place,
 * an indexer reporting a stale head would look exactly like a healthy one, and
 * the lag calculation that gates every verdict would quietly read zero.
 */

import type { ChainHeadSource, NetworkId } from "../types.js";

const DEFAULT_TIMEOUT_MS = 2_000;

export interface JsonRpcChainHeadOptions {
  /** graph-node network id to RPC endpoint. */
  readonly endpoints: Readonly<Record<NetworkId, string>>;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

export class ChainHeadUnavailableError extends Error {
  readonly network: NetworkId;

  constructor(network: NetworkId, reason: string) {
    super(`chain head for ${network} unavailable: ${reason}`);
    this.name = "ChainHeadUnavailableError";
    this.network = network;
  }
}

/** Hex quantity (`0x18e2...`) to number, rejecting anything malformed. */
function parseQuantity(value: unknown, field: string): number {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new TypeError(`${field} was not a hex quantity`);
  }
  const parsed = Number.parseInt(value, 16);
  if (!Number.isSafeInteger(parsed)) {
    throw new TypeError(`${field} exceeded safe integer range`);
  }
  return parsed;
}

export class JsonRpcChainHeadSource implements ChainHeadSource {
  readonly #endpoints: Readonly<Record<NetworkId, string>>;
  readonly #timeoutMs: number;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: JsonRpcChainHeadOptions) {
    this.#endpoints = options.endpoints;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async headBlock(
    network: NetworkId,
  ): Promise<{ number: number; timestamp: number }> {
    const endpoint = this.#endpoints[network];
    if (endpoint === undefined) {
      throw new ChainHeadUnavailableError(network, "no RPC endpoint configured");
    }

    let payload: unknown;
    try {
      const response = await this.#fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_getBlockByNumber",
          // `false` omits transaction bodies: we need the header, and pulling
          // full bodies on every health check is a needless megabyte.
          params: ["latest", false],
        }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      payload = await response.json();
    } catch (cause) {
      throw new ChainHeadUnavailableError(
        network,
        cause instanceof Error ? cause.message : String(cause),
      );
    }

    const result =
      typeof payload === "object" && payload !== null
        ? (payload as { result?: unknown }).result
        : undefined;
    if (typeof result !== "object" || result === null) {
      throw new ChainHeadUnavailableError(network, "RPC returned no block");
    }

    try {
      const block = result as { number?: unknown; timestamp?: unknown };
      return {
        number: parseQuantity(block.number, "block.number"),
        timestamp: parseQuantity(block.timestamp, "block.timestamp"),
      };
    } catch (cause) {
      throw new ChainHeadUnavailableError(
        network,
        cause instanceof Error ? cause.message : String(cause),
      );
    }
  }
}
