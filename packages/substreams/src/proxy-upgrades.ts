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
import { readPackageFromFile } from "@substreams/manifest";
import { createConnectTransport } from "@connectrpc/connect-node";

/** `keccak256("Upgraded(address)")`, the EIP-1967 implementation-change event. */
export const UPGRADED_TOPIC =
  "0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b";

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

export interface ProxyUpgradeIndexOptions {
  /** Substreams API key. Exchanged for a JWT; not the Subgraph Studio key. */
  readonly apiKey: string;
  /** Path to the `ethereum-common` package. */
  readonly packagePath: string;
  readonly endpoint?: string;
  /** How far back to backfill, in blocks. Negative is relative to head. */
  readonly startBlock?: number;
  /** Called for each upgrade seen, for logging or a sink. */
  readonly onUpgrade?: (record: UpgradeRecord) => void;
}

const toHex = (bytes: Uint8Array | undefined): string =>
  `0x${Buffer.from(bytes ?? new Uint8Array()).toString("hex")}`;

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
    txHash: toHex(event.txHash),
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

  /** First block this index observed. Null before the stream produces data. */
  get watchedSince(): number | null {
    return this.#firstBlockSeen;
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
  async run(stopBlock?: number): Promise<void> {
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

    const pkg = await readPackageFromFile(this.#options.packagePath);

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
      startBlockNum: this.#options.startBlock ?? -1000,
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
