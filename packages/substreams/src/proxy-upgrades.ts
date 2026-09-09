/**
 * When did this proxy last change its implementation?
 *
 * R2 can already tell that a contract's logic is replaceable — it reads the
 * proxy slots directly. What a storage read cannot tell it is *when* the logic
 * was last replaced, and that is the part the risk story actually turns on.
 * "This contract is upgradeable" is true of most of DeFi and is worth a
 * shrug. "This contract's implementation changed forty minutes ago" is a
 * different sentence entirely, and it is the shape of the classic rug: deploy
 * something benign, wait for funds, then upgrade.
 *
 * Answering it needs history, not state, which is what Substreams is for. The
 * alternative — polling every proxy's implementation slot and diffing — costs
 * an RPC call per contract per interval and still misses an upgrade that is
 * reverted between polls. A stream sees every one.
 */

import {
  applyParams,
  authIssue,
  createAuthInterceptor,
  createRegistry,
  createRequest,
  streamBlocks,
  unpackMapOutput,
} from "@substreams/core";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readPackageFromFile } from "@substreams/manifest";
import { createConnectTransport } from "@connectrpc/connect-node";

/** `keccak256("Upgraded(address)")`, the EIP-1967 implementation-change event. */
export const UPGRADED_TOPIC =
  "0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b";

/**
 * The vendored `ethereum-common` package.
 *
 * Resolved relative to this module so consumers do not each keep a copy of a
 * 439 KB binary, and so the path cannot drift from the package it belongs to.
 */
export const ETHEREUM_COMMON_SPKG = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "ethereum-common-v0.3.0.spkg",
);

/** StreamingFast's hosted Ethereum mainnet endpoint. */
export const MAINNET_ENDPOINT = "https://mainnet.eth.streamingfast.io";

export interface UpgradeRecord {
  /** Lowercased proxy address. */
  readonly proxy: string;
  /** Implementation the proxy was pointed at. */
  readonly implementation: string;
  readonly block: number;
  /** Block timestamp in seconds, as the chain recorded it. */
  readonly timestamp: number;
  readonly txHash: string;
}

export class SubstreamsError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(`substreams: ${message}`, options);
    this.name = "SubstreamsError";
  }
}

/**
 * How long to wait before reconnecting, and the ceiling for that wait.
 *
 * Two seconds is short enough that an ordinary connection close costs almost
 * no coverage, and the doubling keeps a genuinely broken upstream from being
 * hammered. The ceiling sits below the staleness tolerance's own order of
 * magnitude so a recovering stream is reported live again promptly.
 */
const RECONNECT_MIN_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;

export interface ProxyUpgradeIndexOptions {
  /** Substreams API key. Exchanged for a JWT; not the Subgraph Studio key. */
  readonly apiKey: string;
  /** Path to the `ethereum-common` package. Defaults to the vendored copy. */
  readonly packagePath?: string;
  readonly endpoint?: string;
  /** How far back to backfill, in blocks. Negative is relative to head. */
  readonly startBlock?: number;
  /** Called for each upgrade seen, for logging or a sink. */
  readonly onUpgrade?: (record: UpgradeRecord) => void;
  /** Called when the stream drops, before it is retried. */
  readonly onDisconnect?: (reason: string) => void;
}

const toHex = (bytes: Uint8Array | undefined): string =>
  `0x${Buffer.from(bytes ?? new Uint8Array()).toString("hex")}`;

/**
 * Transaction hash as the stream delivers it.
 *
 * The log's address and topics arrive as raw bytes. `txHash` does not: it
 * arrives as the ASCII *text* of the hex digits, so putting it through
 * {@link toHex} with the others encodes it a second time. The result is a
 * 128-character string that looks like a hash, is accepted everywhere a hash
 * is accepted, and matches no transaction on any chain — the ASCII of a real
 * hash rather than the hash itself.
 *
 * That makes it the worst kind of evidence: plausible in a response, and
 * dead on an explorer. A verdict's whole claim is that a reader can check it,
 * so a hash nobody can look up is worse than no hash at all.
 *
 * Both encodings are handled rather than the one observed, because which one
 * arrives is a property of the upstream module and not of anything here.
 */
function toTxHash(bytes: Uint8Array | undefined): string {
  if (bytes === undefined || bytes.length === 0) return "0x";
  const text = Buffer.from(bytes).toString("utf8");
  if (/^(0x)?[0-9a-f]{64}$/i.test(text)) {
    return `0x${text.replace(/^0x/i, "").toLowerCase()}`;
  }
  return toHex(bytes);
}

/** Last 20 bytes of a 32-byte topic word, which is where an address sits. */
const topicToAddress = (bytes: Uint8Array | undefined): string =>
  `0x${Buffer.from(bytes ?? new Uint8Array()).toString("hex").slice(-40)}`;

/** The shape the stream delivers, narrowed to what this module reads. */
export interface StreamedEvent {
  readonly txHash?: Uint8Array;
  readonly log?: {
    readonly address?: Uint8Array;
    readonly topics?: readonly Uint8Array[];
  };
}

/**
 * Turn a streamed event into a record, or reject it.
 *
 * The topic is re-checked here even though the filter runs server-side. A
 * parameter that fails to apply — which is exactly what happens when it is
 * passed to `createRequest` instead of `applyParams` — yields a healthy-looking
 * stream of entirely different events. Without this guard those would be
 * recorded as proxy upgrades and reported as such.
 */
export function toUpgradeRecord(
  event: StreamedEvent,
  block: number,
  timestamp: number,
): UpgradeRecord | null {
  if (toHex(event.log?.topics?.[0]) !== UPGRADED_TOPIC) return null;

  const proxy = toHex(event.log?.address);
  // A proxy address of 0x is a malformed event, not an upgrade of the zero
  // address; recording it would put an unqueryable key in the index.
  if (proxy.length !== 42) return null;

  return {
    proxy,
    implementation: topicToAddress(event.log?.topics?.[1]),
    block,
    timestamp,
    txHash: toTxHash(event.txHash),
  };
}

/**
 * Keeps the most recent upgrade per proxy.
 *
 * Deliberately in memory and deliberately bounded by what it has seen: this
 * answers "has this proxy been upgraded within the window I have been
 * watching", not "when was it ever upgraded". A rule reading it must treat
 * absence as *unknown* rather than as *never*, which is why {@link lastUpgrade}
 * returns null and {@link watchedSince} is exposed alongside it — a caller
 * cannot honestly interpret the first without the second.
 */
export class ProxyUpgradeIndex {
  readonly #upgrades = new Map<string, UpgradeRecord>();
  #firstBlockSeen: number | null = null;
  #lastBlockSeen: number | null = null;
  #blocks = 0;
  #abort = new AbortController();
  #running = false;
  #lastBlockAt: number | null = null;
  #failure: string | null = null;

  readonly #options: ProxyUpgradeIndexOptions;

  private constructor(options: ProxyUpgradeIndexOptions) {
    this.#options = options;
  }

  static create(options: ProxyUpgradeIndexOptions): ProxyUpgradeIndex {
    return new ProxyUpgradeIndex(options);
  }

  /**
   * Record an upgrade. Public so a caller can replay history from another
   * source into the same index, and so the bookkeeping is testable without a
   * network.
   */
  record(upgrade: UpgradeRecord): void {
    this.#upgrades.set(upgrade.proxy, upgrade);
    this.#firstBlockSeen ??= upgrade.block;
    this.#lastBlockSeen = Math.max(this.#lastBlockSeen ?? 0, upgrade.block);
    this.#options.onUpgrade?.(upgrade);
  }

  /** The most recent upgrade seen for a proxy, or null if none was seen. */
  lastUpgrade(proxy: string): UpgradeRecord | null {
    return this.#upgrades.get(proxy.toLowerCase()) ?? null;
  }

  /**
   * The most recently upgraded proxies, newest first.
   *
   * The index already holds one record per proxy, so this is a view rather
   * than a second store. It exists because "which contracts changed their
   * logic lately" is a question worth answering to callers who are not
   * evaluating a specific transaction — a monitor, or an agent deciding what
   * to look at — and answering it from this index costs them nothing, while
   * running the stream themselves costs a Substreams key and a backfill.
   *
   * Carries no liveness of its own on purpose: a caller must read
   * {@link live} alongside it, because an empty or short list from a stopped
   * stream means nothing at all.
   */
  recent(limit = 20): readonly UpgradeRecord[] {
    return [...this.#upgrades.values()]
      .sort((a, b) => b.block - a.block)
      .slice(0, Math.max(0, limit));
  }

  /** First block this index observed. Null before the stream produces data. */
  get watchedSince(): number | null {
    return this.#firstBlockSeen;
  }

  /**
   * Whether the index is still watching.
   *
   * This is the difference between "no upgrade happened" and "we stopped
   * looking an hour ago", and a consumer that cannot tell them apart will
   * report a dead stream's silence as a clean history. Goes false when the
   * stream ends, errors, or stalls past {@link stalenessToleranceMs}.
   */
  get live(): boolean {
    if (!this.#running || this.#failure !== null) return false;
    if (this.#lastBlockAt === null) return false;
    return Date.now() - this.#lastBlockAt <= this.stalenessToleranceMs;
  }

  /**
   * How long without a block before the index calls itself stale.
   *
   * Ethereum produces a block every twelve seconds or so; two minutes of
   * silence is a stream that has stopped, not a quiet chain.
   */
  readonly stalenessToleranceMs = 120_000;

  /** Why the stream stopped, when it stopped badly. */
  get failure(): string | null {
    return this.#failure;
  }

  get stats(): {
    blocks: number;
    proxies: number;
    firstBlock: number | null;
    lastBlock: number | null;
  } {
    return {
      blocks: this.#blocks,
      proxies: this.#upgrades.size,
      firstBlock: this.#firstBlockSeen,
      lastBlock: this.#lastBlockSeen,
    };
  }

  stop(): void {
    this.#running = false;
    this.#abort.abort();
  }

  /**
   * Consume the stream until stopped.
   *
   * Runs until `stop()`; a caller wanting a bounded backfill passes
   * `stopBlock`. Errors propagate rather than being swallowed — a silently
   * dead stream would leave the index frozen while still answering queries,
   * and a rule would read stale absence as evidence of no upgrade.
   */
  /**
   * Consume the stream, reconnecting until stopped.
   *
   * A gRPC stream ends. Not always with an error — a server closing a
   * long-lived connection is ordinary — and the first version treated that as
   * the end of the work. On a demo that runs for two minutes nothing shows; on
   * a service that runs for days the upgrade history stopped following head
   * after half an hour, silently, and R2 spent the rest of the week reporting
   * its history as unavailable. Correct, and useless.
   *
   * Reconnection resumes from the block after the last one seen, never from
   * head. That is the part which has to be right: resuming at head would leave
   * a hole in the middle of the watched window while {@link watchedSince} went
   * on claiming the window was continuous, and "no upgrade since block N"
   * would become a sentence this index has no standing to say.
   *
   * A bounded backfill — `run(stopBlock)` — still runs exactly once. It has an
   * end by definition, and reconnecting past it would ignore the argument.
   */
  async run(stopBlock?: number): Promise<void> {
    this.#running = true;
    this.#failure = null;

    if (stopBlock !== undefined) {
      try {
        await this.#run(stopBlock);
      } catch (error) {
        this.#failure = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        this.#running = false;
      }
      return;
    }

    let backoffMs = RECONNECT_MIN_MS;
    try {
      while (this.#running) {
        try {
          await this.#run(undefined);
          // A clean end is still an end: nothing to report, but nothing to
          // wait long for either.
          backoffMs = RECONNECT_MIN_MS;
        } catch (error) {
          // Recorded rather than thrown: a caller that started this in the
          // background would otherwise lose the reason, and the index would go
          // on answering as though it were merely quiet. `live` is already
          // false by now, so the failure cannot be read as a clean history.
          this.#failure = error instanceof Error ? error.message : String(error);
          this.#options.onDisconnect?.(this.#failure);
          backoffMs = Math.min(backoffMs * 2, RECONNECT_MAX_MS);
        }

        if (!this.#running) break;
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        if (!this.#running) break;

        // A fresh abort controller: the previous one may already be aborted,
        // and reusing it would end the new stream before it produced a block.
        this.#abort = new AbortController();
        this.#failure = null;
      }
    } finally {
      this.#running = false;
    }
  }

  async #run(stopBlock?: number): Promise<void> {
    const { token } = await authIssue(this.#options.apiKey).catch(
      (cause: unknown) => {
        throw new SubstreamsError(
          "could not exchange the API key for a token. Note this is a " +
            "Substreams key from thegraph.market or streamingfast.io, not a " +
            "Subgraph Studio key — the two are not interchangeable",
          { cause },
        );
      },
    );

    const pkg = await readPackageFromFile(
      this.#options.packagePath ?? ETHEREUM_COMMON_SPKG,
    );

    /*
     * Parameters mutate the module definitions and must be applied before the
     * request is built. `createRequest` has no `params` field: passing one is
     * silently ignored and the module keeps the package's default filter,
     * which streams a different event entirely and looks perfectly healthy.
     */
    applyParams(
      [`filtered_events=evt_sig:${UPGRADED_TOPIC}`],
      pkg.modules?.modules ?? [],
    );

    const registry = createRegistry(pkg);
    /*
     * One cast, at the boundary where it belongs.
     *
     * `@substreams/core` resolves `@connectrpc/connect` and
     * `@bufbuild/protobuf` through their CJS type entry points while
     * `connect-node` presents the ESM ones. Every type crossing between them —
     * Interceptor, IMessageTypeRegistry, and everything they reference — is
     * structurally identical and nominally distinct, so they refuse to unify.
     * The runtime objects are the same, as the live stream confirms.
     *
     * The result is coerced to whatever `streamBlocks` expects, which names
     * the target type instead of erasing it, and keeps the whole problem to
     * this one expression rather than a cast per field and per call site.
     */
    const transport = createConnectTransport({
      baseUrl: this.#options.endpoint ?? MAINNET_ENDPOINT,
      httpVersion: "2",
      interceptors: [createAuthInterceptor(token)],
      jsonOptions: { typeRegistry: registry },
    } as never) as unknown as Parameters<typeof streamBlocks>[0];

    const request = createRequest({
      substreamPackage: pkg,
      outputModule: "filtered_events",
      productionMode: true,
      /*
       * Resume where the last connection left off, not where the process
       * started. On the first connection there is nothing to resume from and
       * the configured backfill applies; on a reconnect, starting anywhere
       * later than the last block seen would open a hole in the middle of the
       * watched window while `watchedSince` kept claiming it was continuous.
       */
      startBlockNum:
        this.#lastBlockSeen === null
          ? (this.#options.startBlock ?? -1000)
          : this.#lastBlockSeen + 1,
      ...(stopBlock === undefined ? {} : { stopBlockNum: stopBlock }),
    });

    for await (const response of streamBlocks(transport, request)) {
      if (this.#abort.signal.aborted) return;
      if (response.message?.case !== "blockScopedData") continue;

      const value = response.message.value as {
        clock?: { number?: bigint; timestamp?: { seconds?: bigint } };
      };
      const block = Number(value.clock?.number ?? 0);
      const timestamp = Number(value.clock?.timestamp?.seconds ?? 0);

      this.#blocks += 1;
      this.#firstBlockSeen ??= block;
      this.#lastBlockSeen = block;
      this.#lastBlockAt = Date.now();

      const output = unpackMapOutput(response, registry) as
        | { events?: StreamedEvent[] }
        | undefined;

      for (const event of output?.events ?? []) {
        const record = toUpgradeRecord(event, block, timestamp);
        if (record === null) continue;
        this.record(record);
      }
    }
  }
}
