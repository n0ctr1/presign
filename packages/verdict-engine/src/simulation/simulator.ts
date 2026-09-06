/**
 * Runs an unsigned transaction against a fork and reports what it changed.
 *
 * `debug_traceCall` with the prestate tracer in diff mode returns the exact
 * pre and post state the transaction touches. That is the evidence rules read.
 * Nothing here interprets the result — interpretation is the rules' job, and
 * keeping the two apart is what lets a finding cite a raw storage write rather
 * than a summary of one.
 */

import type {
  AccountDiff,
  Address,
  Hex,
  StateDiff,
  UnsignedTransaction,
} from "../types.js";

export class SimulationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(`simulation failed: ${message}`, options);
    this.name = "SimulationError";
  }
}

interface RpcAccount {
  balance?: string;
  nonce?: number;
  code?: string;
  storage?: Record<string, string>;
}

function toAccountDiff(raw: RpcAccount): AccountDiff {
  const diff: {
    balance?: bigint;
    nonce?: number;
    code?: Hex;
    storage?: Record<Hex, Hex>;
  } = {};
  if (typeof raw.balance === "string") diff.balance = BigInt(raw.balance);
  if (typeof raw.nonce === "number") diff.nonce = raw.nonce;
  if (typeof raw.code === "string") diff.code = raw.code as Hex;
  if (raw.storage !== undefined) {
    diff.storage = Object.fromEntries(
      Object.entries(raw.storage).map(([slot, value]) => [
        slot.toLowerCase() as Hex,
        value as Hex,
      ]),
    ) as Record<Hex, Hex>;
  }
  return diff;
}

function toAccountMap(
  raw: Record<string, RpcAccount> | undefined,
): Record<Address, AccountDiff> {
  if (raw === undefined) return {};
  return Object.fromEntries(
    Object.entries(raw).map(([address, account]) => [
      address.toLowerCase() as Address,
      toAccountDiff(account),
    ]),
  ) as Record<Address, AccountDiff>;
}

export class ForkSimulator {
  readonly #rpcUrl: string;
  readonly #timeoutMs: number;

  constructor(rpcUrl: string, options: { timeoutMs?: number } = {}) {
    this.#rpcUrl = rpcUrl;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  async #rpc<T>(method: string, params: unknown[]): Promise<T> {
    let payload: { result?: T; error?: { message?: string } };
    try {
      const response = await fetch(this.#rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      payload = (await response.json()) as typeof payload;
    } catch (cause) {
      throw new SimulationError(
        `${method}: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }
    if (payload.error !== undefined) {
      throw new SimulationError(`${method}: ${payload.error.message ?? "rpc error"}`);
    }
    return payload.result as T;
  }

  /** Encode a transaction the way the JSON-RPC call object expects. */
  static #callObject(transaction: UnsignedTransaction) {
    return {
      from: transaction.from,
      ...(transaction.to === null ? {} : { to: transaction.to }),
      data: transaction.data,
      value: `0x${transaction.value.toString(16)}`,
    };
  }

  /**
   * Simulate and return the diff.
   *
   * Revert is detected with a separate `eth_call` rather than inferred from an
   * empty diff. A reverted transaction can still produce a non-empty prestate,
   * and treating that as a real state change would let a rule report an
   * approval that never happens.
   */
  async simulate(transaction: UnsignedTransaction): Promise<StateDiff> {
    const call = ForkSimulator.#callObject(transaction);

    const blockNumber = Number(await this.#rpc<string>("eth_blockNumber", []));

    let revertReason: string | null = null;
    try {
      await this.#rpc<string>("eth_call", [call, "latest"]);
    } catch (error) {
      revertReason =
        error instanceof SimulationError ? error.message : String(error);
    }

    const trace = await this.#rpc<{
      pre?: Record<string, RpcAccount>;
      post?: Record<string, RpcAccount>;
    }>("debug_traceCall", [
      call,
      "latest",
      { tracer: "prestateTracer", tracerConfig: { diffMode: true } },
    ]);

    return {
      pre: toAccountMap(trace.pre),
      post: toAccountMap(trace.post),
      blockNumber,
      revertReason,
    };
  }

  getStorageAt(address: Address, slot: Hex): Promise<Hex> {
    return this.#rpc<Hex>("eth_getStorageAt", [address, slot, "latest"]);
  }

  getCode(address: Address): Promise<Hex> {
    return this.#rpc<Hex>("eth_getCode", [address, "latest"]);
  }
}
