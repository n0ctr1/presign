/**
 * When code first appeared at an address.
 *
 * R4 needs a contract's age, and there is no RPC method that returns it. The
 * only primitive available is `eth_getCode` at a historical block, so age has
 * to be *searched* for. Doing that naively — bisecting the whole chain — costs
 * around twenty-five sequential round trips on mainnet, which is most of the
 * one-second budget a pre-signature verdict has to fit inside.
 *
 * So the search is shaped like the question the rule actually asks. The rule
 * does not need an exact birthday for a contract deployed in 2020; it needs to
 * know whether this one is young enough to be suspicious. One code read at a
 * horizon block answers that for the overwhelming majority of counterparties,
 * and the bisection only runs inside the horizon window, where it is short.
 *
 * The result type says which of those two happened, because they are different
 * claims. `deployed` is a measured block; `older_than` is a bound we paid for
 * and nothing more. Collapsing them would let the rule quote a precision the
 * search never bought.
 */

import type { Address } from "../types.js";

/**
 * Where the search stops looking precisely.
 *
 * Seven days, matching R4's default suspicion window: the horizon exists to
 * answer that rule's question, and a horizon shorter than the window it feeds
 * would make the answer unusable.
 */
export const DEFAULT_HORIZON_SECONDS = 7 * 24 * 60 * 60;

/** Mainnet, post-merge. Only a starting guess; the horizon is then verified. */
const DEFAULT_SECONDS_PER_BLOCK = 12;

const DEFAULT_TIMEOUT_MS = 4_000;

/**
 * How far back the horizon estimate may be stretched when the guess above is
 * wrong for this chain. Three doublings covers an eightfold error in block
 * time, which is more than any live network is off by.
 */
const MAX_HORIZON_DOUBLINGS = 3;

export type ContractOrigin =
  /** Code first appeared in this block. Found by bisection. */
  | { readonly status: "deployed"; readonly block: number; readonly timestamp: number }
  /**
   * Code already existed at this block and the search stopped there.
   *
   * The contract is at least as old as `timestamp`; how much older is unknown
   * and was deliberately not paid for.
   */
  | { readonly status: "older_than"; readonly block: number; readonly timestamp: number }
  /** The age could not be established. Never to be read as "young" or "old". */
  | { readonly status: "indeterminate"; readonly reason: string };

export interface ContractOriginSource {
  originOf(address: Address): Promise<ContractOrigin>;
}

export interface RpcContractOriginOptions {
  /**
   * Archive-capable RPC endpoint.
   *
   * Historical `eth_getCode` is an archive read once the chain moves past the
   * block, and public endpoints refuse it. This is the same URL the fork is
   * taken from, for the same reason.
   */
  readonly url: string;
  /** How far back to search precisely. Beyond it the answer is a bound. */
  readonly horizonSeconds?: number;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
}

interface Block {
  readonly number: number;
  readonly timestamp: number;
}

/** Hex quantity to number, rejecting anything malformed. */
function quantity(value: unknown, field: string): number {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new TypeError(`${field} was not a hex quantity`);
  }
  const parsed = Number.parseInt(value, 16);
  if (!Number.isSafeInteger(parsed)) {
    throw new TypeError(`${field} exceeded safe integer range`);
  }
  return parsed;
}

export class RpcContractOrigin implements ContractOriginSource {
  readonly #url: string;
  readonly #horizonSeconds: number;
  readonly #timeoutMs: number;
  readonly #fetch: typeof globalThis.fetch;
  /**
   * An address's deployment does not change, so the answer is cached for the
   * life of the process. Without this, a demo calling the same counterparty
   * four times pays for the search four times.
   */
  readonly #cache = new Map<string, ContractOrigin>();

  constructor(options: RpcContractOriginOptions) {
    this.#url = options.url;
    this.#horizonSeconds = options.horizonSeconds ?? DEFAULT_HORIZON_SECONDS;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async #rpc(method: string, params: readonly unknown[]): Promise<unknown> {
    const response = await this.#fetch(this.#url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
    const body = (await response.json()) as {
      result?: unknown;
      error?: { message?: string };
    };
    if (body.error !== undefined) {
      throw new Error(`${method}: ${body.error.message ?? "RPC error"}`);
    }
    return body.result;
  }

  async #block(tag: string): Promise<Block> {
    const raw = await this.#rpc("eth_getBlockByNumber", [tag, false]);
    if (raw === null || typeof raw !== "object") {
      throw new Error(`eth_getBlockByNumber(${tag}) returned no block`);
    }
    const row = raw as Record<string, unknown>;
    return {
      number: quantity(row["number"], "block.number"),
      timestamp: quantity(row["timestamp"], "block.timestamp"),
    };
  }

  /** True when the address has code at this block. */
  async #hasCode(address: Address, block: number): Promise<boolean> {
    const code = await this.#rpc("eth_getCode", [address, `0x${block.toString(16)}`]);
    return typeof code === "string" && code.length > 2;
  }

  /**
   * A block at least the configured horizon older than head.
   *
   * The block count is estimated from an assumed block time and then
   * **verified** against the block's own timestamp, because the estimate is
   * the one place a wrong constant would change a verdict: a horizon that
   * silently lands three days back would report a four-day-old contract as
   * "older than seven days", turning a high verdict into a medium one.
   */
  async #horizon(head: Block): Promise<Block> {
    let span = Math.ceil(this.#horizonSeconds / DEFAULT_SECONDS_PER_BLOCK);
    for (let attempt = 0; attempt <= MAX_HORIZON_DOUBLINGS; attempt += 1) {
      const number = Math.max(0, head.number - span);
      const block = await this.#block(`0x${number.toString(16)}`);
      if (number === 0 || head.timestamp - block.timestamp >= this.#horizonSeconds) {
        return block;
      }
      span *= 2;
    }
    throw new Error("could not reach a block older than the horizon");
  }

  async originOf(address: Address): Promise<ContractOrigin> {
    const key = address.toLowerCase();
    const cached = this.#cache.get(key);
    if (cached !== undefined) return cached;

    const origin = await this.#search(address);
    this.#cache.set(key, origin);
    return origin;
  }

  async #search(address: Address): Promise<ContractOrigin> {
    try {
      const head = await this.#block("latest");
      if (!(await this.#hasCode(address, head.number))) {
        // Either never deployed or self-destructed. Both are the caller's
        // question to answer from the code it can see, not ours to guess.
        return { status: "indeterminate", reason: "no code at chain head" };
      }

      const horizon = await this.#horizon(head);
      if (await this.#hasCode(address, horizon.number)) {
        return {
          status: "older_than",
          block: horizon.number,
          timestamp: horizon.timestamp,
        };
      }

      /*
       * Bisect (absent, present]. `low` always lacks code and `high` always
       * has it, so the loop narrows to the first block that does — which is
       * the block the deployment landed in.
       */
      let low = horizon.number;
      let high = head.number;
      while (low + 1 < high) {
        const mid = Math.floor((low + high) / 2);
        if (await this.#hasCode(address, mid)) high = mid;
        else low = mid;
      }

      const block = await this.#block(`0x${high.toString(16)}`);
      return { status: "deployed", block: high, timestamp: block.timestamp };
    } catch (error) {
      return {
        status: "indeterminate",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
