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

  return server;
}
