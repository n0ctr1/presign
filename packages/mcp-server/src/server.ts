/**
 * MCP surface over the operational layer.
 *
 * The question this server exists to answer is "which indexed deployments can
 * serve this risk rule right now, and how stale is each one" — deliberately
 * separable from the verdict engine, so another team can consume freshness-
 * gated data selection without adopting our rules, our simulation or our
 * opinions about what is risky.
 *
 * Every response carries provenance. A caller that cannot see which deployment
 * answered and how far behind it was cannot audit the answer, and an
 * unauditable freshness claim is worth about as much as no claim.
 *
 * The upgrade-history tools are the exception to "freshness-gated selection",
 * and they are here for the same reason the rest is: they answer a question no
 * subgraph can. When a proxy's implementation last changed is not a field in
 * any schema — it is an event, and reading it needs a stream. A consumer of
 * this server gets that history without holding a Substreams key or waiting
 * out a backfill, which is the part that is actually reusable.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  effectiveLagSeconds,
  findRequirement,
  RULE_REQUIREMENTS,
  type CapabilityResolution,
  type DeploymentRecord,
  type RuleRequirement,
} from "@presign/operational-layer";
import { z } from "zod";

import type { ServerConfig } from "./config.js";

const SCHEMA_FAMILIES = [
  "lending-cdp",
  "dex-amm",
  "yield-vault",
  "staking",
  "perpetuals",
] as const;

/** JSON text is the payload; MCP content blocks are only the envelope. */
function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function serializeRecord(record: DeploymentRecord, now: Date) {
  return {
    deployment_id: record.candidate.deploymentId,
    subgraph_id: record.candidate.subgraphId,
    display_name: record.candidate.displayName,
    network: record.candidate.network,
    // Measured lag, and lag as it stands now including the age of the
    // measurement. The second number is the one a freshness budget is
    // enforced against; the first is what was actually observed.
    lag_seconds: record.liveness.lagSeconds,
    effective_lag_seconds: Number(effectiveLagSeconds(record, now).toFixed(1)),
    blocks_behind: record.liveness.blocksBehind,
    indexed_block: record.liveness.indexedBlock,
    head_block: record.liveness.headBlock,
    has_indexing_errors: record.liveness.hasIndexingErrors,
    answers_fields: record.conformance.answersFields,
    missing_fields: record.conformance.missingFields,
    measured_at: record.liveness.checkedAt.toISOString(),
    query_url: record.candidate.queryUrl,
    query_url_x402: record.candidate.queryUrlX402,
    // Economic score, passed through for transparency. It is never used to
    // order this list: it tracks traction and therefore age.
    reliability_score: record.candidate.reliability,
  };
}

function serializeResolution(
  resolution: CapabilityResolution,
  requirement: RuleRequirement,
  network: string,
  now: Date,
) {
  const head = {
    rule_id: resolution.ruleId,
    schema_family: requirement.schemaFamily,
    network,
    root_field: requirement.rootField,
    required_fields: requirement.requiredFields,
    max_lag_seconds: requirement.maxLagSeconds,
    resolved_at: now.toISOString(),
  };

  if (resolution.satisfied) {
    return {
      ...head,
      satisfied: true,
      deployments: resolution.records.map((r) => serializeRecord(r, now)),
    };
  }

  return {
    ...head,
    satisfied: false,
    reason: resolution.reason,
    // Callers must fail closed on this. "Unavailable" is not "safe": the
    // whole point of the layer is that a green answer is unreachable without
    // fresh context.
    guidance:
      "Treat as unavailable, never as low risk. A verdict computed without fresh protocol context must not be green.",
    rejected: resolution.rejected.map((r) => serializeRecord(r, now)),
  };
}

/** One implementation swap, as the stream observed it. */
export interface UpgradeRecordView {
  readonly proxy: string;
  readonly implementation: string;
  readonly block: number;
  readonly timestamp: number;
  readonly txHash: string;
}

/**
 * The proxy upgrade stream, narrowed to what this server reads.
 *
 * `@presign/substreams`'s index satisfies it structurally, so nothing here
 * depends on how the history is produced — a caller replaying upgrades from a
 * log file into the same shape gets the same tools.
 */
export interface UpgradeHistorySource {
  lastUpgrade(proxy: string): UpgradeRecordView | null;
  recent(limit: number): readonly UpgradeRecordView[];
  readonly watchedSince: number | null;
  readonly live: boolean;
  readonly failure: string | null;
  readonly stats: {
    readonly blocks: number;
    readonly proxies: number;
    readonly firstBlock: number | null;
    readonly lastBlock: number | null;
  };
}

function serializeUpgrade(record: UpgradeRecordView, now: Date) {
  const observedAt = new Date(record.timestamp * 1000);
  return {
    proxy: record.proxy,
    implementation: record.implementation,
    block: record.block,
    observed_at: observedAt.toISOString(),
    age_seconds: Number(((now.getTime() - observedAt.getTime()) / 1000).toFixed(1)),
    transaction_hash: record.txHash,
  };
}

/**
 * The watched window, attached to every upgrade-history answer.
 *
 * This is the whole honesty of these two tools. The index knows only what it
 * has seen since it started, so "no upgrade recorded" covers two situations a
 * caller must not conflate: the proxy has never been upgraded, and the proxy
 * was upgraded before anyone started watching. Reporting the window turns an
 * unfalsifiable "clean" into a checkable "clean since block N" — and when the
 * stream is not live, the answer carries no information at all.
 */
function serializeSource(history: UpgradeHistorySource) {
  return {
    live: history.live,
    failure: history.failure,
    watched_since_block: history.watchedSince,
    watched_blocks: history.stats.blocks,
    proxies_seen: history.stats.proxies,
    last_block: history.stats.lastBlock,
  };
}

export function createServer(config: ServerConfig, now: () => Date = () => new Date()) {
  const server = new McpServer({ name: "presign", version: "0.0.1" });

  server.registerTool(
    "resolve_rule_capability",
    {
      title: "Resolve rule capability",
      description:
        "Which indexed deployments can serve a risk rule right now, within a freshness budget. Returns each deployment's lag from chain head and the fields it actually answers. If unsatisfied, returns a reason — treat that as unavailable, never as low risk.",
      inputSchema: {
        rule_id: z.string().describe("Rule identifier, e.g. R3."),
        schema_family: z
          .enum(SCHEMA_FAMILIES)
          .describe("Schema family the rule reads."),
        network: z
          .string()
          .default("mainnet")
          .describe("graph-node network id, e.g. mainnet, base, arbitrum-one."),
        max_lag_seconds: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Override the rule's default freshness budget."),
        refresh: z
          .boolean()
          .default(false)
          .describe("Re-probe candidates instead of answering from warm cache."),
      },
    },
    async ({ rule_id, schema_family, network, max_lag_seconds, refresh }) => {
      const base = findRequirement(rule_id, schema_family);
      if (base === null) {
        return json({
          error: "unknown_requirement",
          message: `no requirement defined for ${rule_id} on ${schema_family}`,
          available: RULE_REQUIREMENTS.map((r) => ({
            rule_id: r.ruleId,
            schema_family: r.schemaFamily,
          })),
        });
      }

      const requirement: RuleRequirement =
        max_lag_seconds === undefined
          ? base
          : { ...base, maxLagSeconds: max_lag_seconds };

      // Warm on demand the first time, so a caller is never told "not_warmed"
      // for a rule they have every right to ask about.
      const warmed = config.index.warmedAt(rule_id, schema_family, network);
      const resolution =
        refresh || warmed === null
          ? await config.index.warm(requirement, network)
          : config.index.resolve(requirement, network);

      return json({
        ...serializeResolution(resolution, requirement, network, now()),
        warmed_at:
          config.index.warmedAt(rule_id, schema_family, network)?.toISOString() ?? null,
      });
    },
  );

  server.registerTool(
    "check_deployment_freshness",
    {
      title: "Check deployment freshness",
      description:
        "How far a specific deployment is behind chain head, in blocks and in seconds, and whether it reports indexing errors. Chain head comes from an independent RPC, so a stalled chain is distinguishable from a stalled indexer.",
      inputSchema: {
        deployment_id: z
          .string()
          .describe("Pinned deployment id (IPFS hash, Qm…), not a subgraph id."),
        network: z.string().default("mainnet"),
      },
    },
    async ({ deployment_id, network }) => {
      try {
        const report = await config.liveness.check(deployment_id, network);
        return json({
          deployment_id: report.deploymentId,
          network,
          indexed_block: report.indexedBlock,
          indexed_block_timestamp: report.indexedBlockTimestamp,
          head_block: report.headBlock,
          blocks_behind: report.blocksBehind,
          lag_seconds: report.lagSeconds,
          has_indexing_errors: report.hasIndexingErrors,
          checked_at: report.checkedAt.toISOString(),
        });
      } catch (error) {
        return json({
          error: "probe_failed",
          deployment_id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  server.registerTool(
    "check_deployment_conformance",
    {
      title: "Check deployment conformance",
      description:
        "Which of the named fields a deployment actually answers. Verified by executing a probe query, not by reading the schema: a field can be declared and still fail at execution.",
      inputSchema: {
        deployment_id: z.string().describe("Pinned deployment id (IPFS hash)."),
        root_field: z.string().describe("Root query field, e.g. markets."),
        fields: z.array(z.string()).min(1).describe("Fields to probe."),
      },
    },
    async ({ deployment_id, root_field, fields }) => {
      try {
        const report = await config.conformance.check(deployment_id, {
          rootField: root_field,
          fields,
        });
        return json({
          deployment_id: report.deploymentId,
          root_field,
          answers_fields: report.answersFields,
          missing_fields: report.missingFields,
          checked_at: report.checkedAt.toISOString(),
        });
      } catch (error) {
        return json({
          error: "probe_failed",
          deployment_id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  server.registerTool(
    "identify_protocol_by_contract",
    {
      title: "Identify protocol by contract",
      description:
        "Deployments whose manifest indexes a given contract address. Use to identify a transaction counterparty as a known protocol before deciding which rule applies.",
      inputSchema: {
        address: z.string().describe("Contract address, 0x-prefixed."),
        network: z.string().default("mainnet"),
      },
    },
    async ({ address, network }) => {
      const candidates = await config.discovery.findByContract(address, network);
      return json({
        address: address.toLowerCase(),
        network,
        // An empty list is meaningful: it is the "unknown contract" verdict
        // class, not an error. No indexed protocol claims this address.
        identified: candidates.length > 0,
        deployments: candidates.map((c) => ({
          deployment_id: c.deploymentId,
          display_name: c.displayName,
          schema_family: c.schemaFamily,
          matched_contracts: c.contractAddresses,
          reliability_score: c.reliability,
        })),
      });
    },
  );

  server.registerTool(
    "list_rule_requirements",
    {
      title: "List rule requirements",
      description:
        "Every rule and schema family this server can resolve, with the fields each reads and its default freshness budget.",
      inputSchema: {},
    },
    () =>
      json({
        requirements: RULE_REQUIREMENTS.map((r) => ({
          rule_id: r.ruleId,
          schema_family: r.schemaFamily,
          root_field: r.rootField,
          required_fields: r.requiredFields,
          max_lag_seconds: r.maxLagSeconds,
        })),
        note:
          "Only rules needing indexed protocol data appear here. Approval and proxy-mutability rules read calldata, simulated state diffs and storage slots, so they have no indexed-data requirement.",
      }),
  );

  /*
   * Registered only when a stream is actually running.
   *
   * The same rule the paid service follows: a capability that cannot be served
   * is not advertised. A tool that exists and always answers "no history"
   * would be worse than its absence, because a caller has no way to tell that
   * from a proxy with a genuinely clean record.
   */
  const history = config.upgrades;
  if (history !== undefined) {
    server.registerTool(
      "check_proxy_upgrade_history",
      {
        title: "Check proxy upgrade history",
        description:
          "When a proxy's implementation last changed, from a live event stream rather than a subgraph. No schema carries this: an upgrade is an event, and current state cannot say when it happened. Read `source.watched_since_block` with the answer — a null upgrade means either never upgraded or upgraded before watching began, and when `source.live` is false the answer carries no information at all.",
        inputSchema: {
          address: z.string().describe("Proxy contract address, 0x-prefixed."),
        },
      },
      ({ address }) => {
        const proxy = address.toLowerCase();
        const last = history.lastUpgrade(proxy);
        return json({
          proxy,
          upgraded: last !== null,
          last_upgrade: last === null ? null : serializeUpgrade(last, now()),
          source: serializeSource(history),
          guidance:
            last !== null
              ? "An implementation that changed recently invalidates any review of the previous code. Weigh how recently against how long a human would need to notice."
              : "Absence is bounded by the watched window, not by the contract's lifetime. Treat it as 'no upgrade since watching began', never as 'never upgraded'.",
        });
      },
    );

    server.registerTool(
      "list_recent_upgrades",
      {
        title: "List recent proxy upgrades",
        description:
          "Proxies whose implementation changed most recently, newest first, across everything the stream has watched. One row per proxy: the most recent change, not every change. Useful for deciding what to look at without running a stream of your own.",
        inputSchema: {
          limit: z
            .number()
            .int()
            .min(1)
            .max(200)
            .default(20)
            .describe("Maximum rows to return."),
        },
      },
      ({ limit }) => {
        const at = now();
        return json({
          upgrades: history.recent(limit).map((r) => serializeUpgrade(r, at)),
          source: serializeSource(history),
          // Said explicitly because a short list reads as a quiet chain, and
          // a caller who does not know the window will draw that conclusion.
          note: "Covers only the watched window in `source`, which begins when this server started streaming — not the whole chain.",
        });
      },
    );
  }

  return server;
}
