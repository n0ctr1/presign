/**
 * Measures how far a deployment is behind, and how old its newest data is.
 *
 * This is the probe that makes a green verdict possible. Everything else in
 * the layer narrows a candidate list; this decides whether the data behind a
 * verdict is recent enough to sign against.
 */

import type { GatewayClient } from "../gateway/client.js";
import type {
  ChainHeadSource,
  DeploymentId,
  LivenessReport,
  NetworkId,
} from "../types.js";

/**
 * `_meta` is served by every graph-node deployment regardless of schema, which
 * is what makes one liveness probe work across the whole corpus.
 */
const META_QUERY = `{
  _meta {
    block { number timestamp }
    hasIndexingErrors
  }
}`;

interface MetaResponse {
  _meta?: {
    block?: { number?: unknown; timestamp?: unknown };
    hasIndexingErrors?: unknown;
  } | null;
}

export interface LivenessProbeOptions {
  readonly gateway: GatewayClient;
  readonly chainHead: ChainHeadSource;
  /** Injectable so tests do not depend on wall clock. */
  readonly now?: () => Date;
}

export class LivenessProbe {
  readonly #gateway: GatewayClient;
  readonly #chainHead: ChainHeadSource;
  readonly #now: () => Date;

  constructor(options: LivenessProbeOptions) {
    this.#gateway = options.gateway;
    this.#chainHead = options.chainHead;
    this.#now = options.now ?? (() => new Date());
  }

  async check(
    deploymentId: DeploymentId,
    network: NetworkId,
  ): Promise<LivenessReport> {
    // Issued together: a sequential pair would measure the indexer and the
    // chain seconds apart and report the gap between them as indexer lag.
    const [meta, head] = await Promise.all([
      this.#gateway.query<MetaResponse>(deploymentId, META_QUERY),
      this.#chainHead.headBlock(network),
    ]);

    const block = meta._meta?.block;
    const indexedBlock = block?.number;
    const indexedBlockTimestamp = block?.timestamp;

    if (
      typeof indexedBlock !== "number" ||
      typeof indexedBlockTimestamp !== "number"
    ) {
      throw new TypeError(
        `deployment ${deploymentId} returned no usable _meta block`,
      );
    }

    const checkedAt = this.#now();

    return {
      deploymentId,
      indexedBlock,
      indexedBlockTimestamp,
      headBlock: head.number,
      // Clamped at zero: an indexer momentarily ahead of the head this RPC
      // happens to see is a reorg or a lagging RPC, never negative lag.
      blocksBehind: Math.max(0, head.number - indexedBlock),
      lagSeconds: Math.max(
        0,
        Math.round(checkedAt.getTime() / 1000) - indexedBlockTimestamp,
      ),
      // Absent is treated as erroring. graph-node always sends this field, so
      // its absence means we are not talking to what we think we are, and the
      // fail-closed reading is the only safe one.
      hasIndexingErrors: meta._meta?.hasIndexingErrors !== false,
      checkedAt,
    };
  }
}
