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

export interface ForkSimulatorOptions {
  readonly timeoutMs?: number;
  /**
   * Re-fork once the pinned block is older than this, in seconds.
   *
   * Omit and the fork never moves, which is right for a demo that runs for a
   * minute and wrong for a service that runs for days. Anvil pins the fork at
   * the block it started on and mines nothing, so a long-lived process
   * simulates every transaction against the state of whenever it booted while
   * reporting a current lag for its indexed data. The verdict would declare
   * `simulatedAtBlock` honestly and still be the exact mismatch this project
   * exists to prevent: fresh-looking evidence resting on a stale view.
   */
  readonly maxForkAgeSeconds?: number;
  /** Upstream to re-fork from. Required for {@link maxForkAgeSeconds}. */
  readonly forkUrl?: string;
  readonly now?: () => Date;
  /** Injectable so the refresh policy is testable without an anvil. */
  readonly fetch?: typeof globalThis.fetch;
}

export class ForkSimulator {
  readonly #rpcUrl: string;
  readonly #timeoutMs: number;
  readonly #maxForkAgeSeconds: number | null;
  readonly #forkUrl: string | null;
  readonly #now: () => Date;
  readonly #fetch: typeof globalThis.fetch;

  /** Read once from the fork; a reset re-forks the same upstream. */
  #chainId: Promise<number> | null = null;

  /** Verdicts currently reading the fork. A reset must not land among them. */
  #active = 0;
  #resetting = false;
  #waiting: (() => void)[] = [];

  constructor(rpcUrl: string, options: ForkSimulatorOptions = {}) {
    this.#rpcUrl = rpcUrl;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#maxForkAgeSeconds = options.maxForkAgeSeconds ?? null;
    this.#forkUrl = options.forkUrl ?? null;
    this.#now = options.now ?? (() => new Date());
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (this.#maxForkAgeSeconds !== null && this.#forkUrl === null) {
      throw new TypeError("maxForkAgeSeconds needs forkUrl to re-fork from");
    }
  }

  /**
   * The chain whose state this fork holds.
   *
   * Asked of the fork rather than configured, so the guard that depends on it
   * cannot be satisfied by a setting that disagrees with the state actually
   * loaded. A failed read is not remembered: the next verdict asks again.
   */
  chainId(): Promise<number> {
    if (this.#chainId === null) {
      const pending = this.#rpc<string>("eth_chainId", []).then((raw) => Number(raw));
      this.#chainId = pending;
      pending.catch(() => {
        if (this.#chainId === pending) this.#chainId = null;
      });
    }
    return this.#chainId;
  }

  /**
   * Run one verdict against a fork no older than the configured age.
   *
   * The lease spans the whole verdict rather than the simulation alone,
   * because the rules keep reading the fork after the diff is taken — R2 reads
   * proxy slots, R4 reads code. A reset between the diff and those reads would
   * hand a rule storage from a different block than the diff it is reasoning
   * about, which is a subtler version of the same bug `--no-mining` prevents:
   * the state moving while the verdict is being formed.
   */
  async withFreshFork<T>(work: () => Promise<T>): Promise<T> {
    await this.#refreshIfStale();
    this.#active += 1;
    try {
      return await work();
    } finally {
      this.#active -= 1;
      if (this.#active === 0) this.#wake();
    }
  }

  #wake(): void {
    const waiting = this.#waiting;
    this.#waiting = [];
    for (const resume of waiting) resume();
  }

  /** Age of the fork's pinned block, in seconds, from its own timestamp. */
  async #forkAgeSeconds(): Promise<number> {
    const block = await this.#rpc<{ timestamp?: string } | null>(
      "eth_getBlockByNumber",
      ["latest", false],
    );
    const raw = block?.timestamp;
    if (typeof raw !== "string") return Number.POSITIVE_INFINITY;
    return this.#now().getTime() / 1000 - Number.parseInt(raw, 16);
  }

  async #refreshIfStale(): Promise<void> {
    if (this.#maxForkAgeSeconds === null || this.#forkUrl === null) return;

    // A reset already under way: wait for it rather than starting a second.
    while (this.#resetting) {
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    }

    if ((await this.#forkAgeSeconds()) <= this.#maxForkAgeSeconds) return;

    this.#resetting = true;
    try {
      // Drain the verdicts already reading the fork before moving it.
      while (this.#active > 0) {
        await new Promise<void>((resolve) => this.#waiting.push(resolve));
      }
      await this.#rpc<null>("anvil_reset", [
        { forking: { jsonRpcUrl: this.#forkUrl } },
      ]);
    } finally {
      this.#resetting = false;
      this.#wake();
    }
  }

  async #rpc<T>(method: string, params: unknown[]): Promise<T> {
    let payload: { result?: T; error?: { message?: string } };
    try {
      const response = await this.#fetch(this.#rpcUrl, {
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

  /** Read-only call; null on revert, since a missing interface is not an error. */
  async call(address: Address, data: Hex): Promise<Hex | null> {
    try {
      return await this.#rpc<Hex>("eth_call", [{ to: address, data }, "latest"]);
    } catch {
      return null;
    }
  }

  /** Bind the read helpers into the shape a rule expects. */
  asRuleReaders() {
    return {
      getStorageAt: this.getStorageAt.bind(this),
      getCode: this.getCode.bind(this),
      call: this.call.bind(this),
    };
  }
}
