/**
 * Adapter over `subgraph-registry-mcp`, used as the discovery source.
 *
 * Discovery is a dependency, not something this project rebuilds. The registry
 * crawls the Graph Network meta-subgraph, classifies the corpus, and extracts
 * contract addresses from every manifest — four days of work we do not repeat.
 *
 * What crosses this boundary is deliberately narrow. The registry's
 * `reliability_score` is carried through as an informational number and is
 * never consulted for freshness: it is a composite of query fees, 30-day
 * volume, curation signal and indexer allocation, all cumulative, so it tracks
 * traction and therefore age. A deployment shipped last month scores near zero
 * however well it indexes, and a deployment that stopped indexing this morning
 * keeps the score it earned last year.
 */

import type {
  DeploymentCandidate,
  DiscoverySource,
  NetworkId,
  SchemaFamily,
} from "../types.js";

/**
 * Minimal transport contract: anything that can invoke a registry tool by name.
 *
 * Kept as an interface so the layer works over stdio MCP, the SSE/HTTP
 * transport or the REST API without changes, and so the mapping below can be
 * unit-tested against recorded payloads with no network.
 */
export interface RegistryToolCaller {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

/**
 * Registry `protocol_type` values mapped onto the schema families rules bind
 * to. Anything unmapped resolves to `null` rather than to a guess: a rule that
 * silently binds to the wrong family is worse than one that reports no
 * candidates, because only the second failure is visible.
 */
const PROTOCOL_TYPE_TO_FAMILY: Readonly<Record<string, SchemaFamily>> = {
  lending: "lending-cdp",
  dex: "dex-amm",
  yield_aggregator: "yield-vault",
  staking: "staking",
  perpetuals: "perpetuals",
};

/**
 * Values exactly as the corpus stores them, confirmed against
 * `list_registry_stats`. The multi-word ones are hyphenated
 * (`yield-aggregator`, `nft-marketplace`), not underscored — querying the
 * underscored spelling returns zero rows rather than an error, so the mistake
 * reads as "this family has no deployments" instead of "the filter is wrong".
 */
const FAMILY_TO_PROTOCOL_TYPE: Readonly<Record<SchemaFamily, string>> = {
  "lending-cdp": "lending",
  "dex-amm": "dex",
  "yield-vault": "yield-aggregator",
  staking: "staking",
  perpetuals: "perpetuals",
};

/** Registry rows arrive as loosely-typed JSON; read them defensively. */
type RegistryRow = Record<string, unknown>;

function str(row: RegistryRow, key: string): string | null {
  const value = row[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(row: RegistryRow, key: string): number | null {
  const value = row[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeProtocolType(raw: string | null): SchemaFamily | null {
  if (raw === null) return null;
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return PROTOCOL_TYPE_TO_FAMILY[key] ?? null;
}

/**
 * MCP tool results arrive as a content array whose first block holds a JSON
 * document as text. Unwrap that here so the mappers see plain objects.
 */
function unwrapToolResult(result: unknown): RegistryRow {
  if (typeof result !== "object" || result === null) {
    throw new RegistryProtocolError("tool result was not an object");
  }
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) {
    // Some transports return the decoded document directly.
    return result as RegistryRow;
  }
  const first = content[0] as { text?: unknown } | undefined;
  if (typeof first?.text !== "string") {
    throw new RegistryProtocolError("tool result had no text content block");
  }
  try {
    const parsed: unknown = JSON.parse(first.text);
    if (typeof parsed !== "object" || parsed === null) {
      throw new RegistryProtocolError("tool result text was not a JSON object");
    }
    return parsed as RegistryRow;
  } catch (cause) {
    throw new RegistryProtocolError("tool result text was not valid JSON", {
      cause,
    });
  }
}

function rowsUnder(doc: RegistryRow, key: string): readonly RegistryRow[] {
  const value = doc[key];
  if (!Array.isArray(value)) return [];
  return value.filter(
    (row): row is RegistryRow => typeof row === "object" && row !== null,
  );
}

/**
 * Map one registry row onto a candidate.
 *
 * `ipfs_hash` is the field that matters: it is the pinned deployment id, while
 * `id` is the subgraph id, which floats to whatever version the owner publishes
 * next. Provenance has to name the deployment that actually answered, so a row
 * without an `ipfs_hash` is unusable and is dropped by {@link toCandidate}'s
 * callers rather than carried forward with a substitute.
 */
function toCandidate(row: RegistryRow): DeploymentCandidate | null {
  const deploymentId = str(row, "ipfs_hash");
  const subgraphId = str(row, "id");
  const network = str(row, "network");
  const queryUrl = str(row, "query_url");
  if (
    deploymentId === null ||
    subgraphId === null ||
    network === null ||
    queryUrl === null
  ) {
    return null;
  }

  return {
    deploymentId,
    subgraphId,
    displayName: str(row, "display_name") ?? subgraphId,
    network,
    schemaFamily: normalizeProtocolType(str(row, "protocol_type")),
    // The corpus classifies by protocol *type*, not by protocol slug, so there
    // is no `aave-v3` to read here. Identifying the exact protocol is the
    // contract-lookup path's job, not the classifier's.
    protocol: null,
    contractAddresses: readMatchedContracts(row),
    reliability: num(row, "reliability_score") ?? 0,
    queryUrl,
    queryUrlX402: str(row, "query_url_x402"),
  };
}

/** Addresses are present only on contract-lookup rows; lowercase for comparison. */
function readMatchedContracts(row: RegistryRow): readonly string[] {
  const matched = row["matched_contracts"];
  if (!Array.isArray(matched)) return [];
  const addresses: string[] = [];
  for (const entry of matched) {
    if (typeof entry !== "object" || entry === null) continue;
    const address = (entry as { address?: unknown }).address;
    if (typeof address === "string" && address.length > 0) {
      addresses.push(address.toLowerCase());
    }
  }
  return addresses;
}

/** Raised when the registry answers in a shape this adapter cannot read. */
export class RegistryProtocolError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(`subgraph-registry: ${message}`, options);
    this.name = "RegistryProtocolError";
  }
}

/**
 * `DiscoverySource` backed by the subgraph registry.
 *
 * Testnets and curation-denied deployments are excluded, which is the
 * registry's own default and the right one here: a testnet twin's description
 * is nearly identical to its mainnet original, so it competes for the top slot
 * while indexing a chain the transaction will never touch.
 */
export class SubgraphRegistrySource implements DiscoverySource {
  readonly name = "subgraph-registry";

  readonly #caller: RegistryToolCaller;

  constructor(caller: RegistryToolCaller) {
    this.#caller = caller;
  }

  async findCandidates(query: {
    schemaFamily: SchemaFamily;
    network?: NetworkId;
    limit?: number;
  }): Promise<readonly DeploymentCandidate[]> {
    const args: Record<string, unknown> = {
      protocol_type: FAMILY_TO_PROTOCOL_TYPE[query.schemaFamily],
      limit: query.limit ?? 25,
    };
    if (query.network !== undefined) args["network"] = query.network;

    const doc = unwrapToolResult(
      await this.#caller.callTool("search_subgraphs", args),
    );

    // `subgraphs` holds the ranked matches; `emerging` holds young deployments
    // held back only because the economic score needs 30 days of volume to
    // exist at all. On a freshness-gated path that is not a reason to drop
    // them, so both lists are probed and the probe decides.
    return [...rowsUnder(doc, "subgraphs"), ...rowsUnder(doc, "emerging")]
      .map(toCandidate)
      .filter((candidate): candidate is DeploymentCandidate => candidate !== null);
  }

  async findByContract(
    address: string,
    network: NetworkId,
  ): Promise<readonly DeploymentCandidate[]> {
    const doc = unwrapToolResult(
      await this.#caller.callTool("get_top_subgraph_deployments", {
        contract_address: address,
        chain: network,
      }),
    );

    return rowsUnder(doc, "deployments")
      .map(toCandidate)
      .filter((candidate): candidate is DeploymentCandidate => candidate !== null);
  }
}
