/**
 * An MCP server that lets a model buy a verdict before it signs.
 *
 * The service already answers any agent that can speak HTTP and x402. Most
 * models cannot: an LLM in an MCP client has tools, not a payment client, so
 * somebody had to write the x402 exchange for it before it could ask. This
 * server is that exchange, packaged as a tool. The model calls `get_verdict`;
 * the payment happens inside, within a budget the model cannot raise.
 *
 * Kept apart from `@presign/mcp-server` on purpose. That one is the data layer
 * — which indexed sources can answer a rule right now — and it is designed to
 * be used without our rules or our opinions about risk. Putting paid verdicts
 * there would dissolve exactly the separation it exists for.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BudgetExceededError, formatTinybars, type Payer } from "@presign/payer";
import { z } from "zod";

export interface VerdictServerConfig {
  /** e.g. https://presign.dev */
  readonly baseUrl: string;
  /** Null when no Hedera account is configured; `get_verdict` then explains how. */
  readonly payer: Payer | null;
  /** Shown when the payer is missing, so the model can tell its user what to do. */
  readonly setupHint?: string;
  /** For the free endpoints. Injectable for tests. */
  readonly fetch?: typeof globalThis.fetch;
}

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

/**
 * What each tier obliges the caller to do, attached to every verdict.
 *
 * Stated in the response rather than only in the tool description, because a
 * model acting on a verdict reads the result in front of it, and the one
 * mistake that matters — reading `unavailable` as "nothing found" — is made at
 * exactly that moment.
 */
export const WHAT_TO_DO: Readonly<Record<string, string>> = {
  low:
    "Every rule ran and none found anything. You may sign. Check provenance.sources for how stale " +
    "the evidence was — a low verdict resting on data far behind chain head is a weaker claim.",
  medium: "Real but standing risk. Ask a human before signing. Do not sign unattended.",
  high: "Do not sign. Report the findings to whoever you act for.",
  unavailable:
    "Do not sign. Fresh context could not be obtained, so this transaction was NOT evaluated. " +
    "This is not a softer 'low': treating it as 'nothing found' turns a failure to get data into a green light.",
};

export function createVerdictServer(config: VerdictServerConfig): McpServer {
  const server = new McpServer({ name: "presign-verdict", version: "0.0.1" });
  const get = config.fetch ?? globalThis.fetch;

  server.registerTool(
    "get_quote",
    {
      title: "Get verdict prices",
      description:
        "Free. What a verdict costs and which rules each route runs, before paying anything. " +
        "/verdict/local runs R1 and R2; /verdict/full adds R3 (protocol accounting from freshness-gated indexed data) " +
        "and R4 (whether anyone has ever indexed the counterparty).",
      inputSchema: {},
    },
    async () => json(await (await get(`${config.baseUrl}/quote`)).json()),
  );

  server.registerTool(
    "check_service",
    {
      title: "Check what the verdict service can see",
      description:
        "Free. Which rules are running and whether the data sources are live. When the proxy upgrade " +
        "stream is not live, rule R2 reports upgrade history as unavailable rather than clean.",
      inputSchema: {},
    },
    async () => json(await (await get(`${config.baseUrl}/health`)).json()),
  );

  server.registerTool(
    "get_verdict",
    {
      title: "Get a pre-signature verdict",
      description:
        "PAID, over x402 on Hedera, from a session budget you cannot raise. Call this with an UNSIGNED " +
        "transaction before signing it. Returns a tier — low, medium, high or unavailable — the findings " +
        "behind it, and provenance naming the indexed sources and how far behind chain head they were. " +
        "Act on `what_to_do` in the result. `unavailable` means the transaction was NOT evaluated: never " +
        "sign on it and never treat it as low.",
      inputSchema: {
        transaction: z
          .object({
            from: z.string().describe("Sender address, 0x-prefixed."),
            to: z.string().nullable().describe("Recipient or contract, 0x-prefixed; null for contract creation."),
            value: z.string().default("0").describe("Wei, as a decimal string."),
            data: z.string().default("0x").describe("Calldata, 0x-prefixed."),
            chainId: z.number().int().describe("EVM chain id: 1, 10, 137, 8453 or 42161."),
          })
          .describe("The unsigned transaction to judge."),
        route: z
          .enum(["local", "full"])
          .default("full")
          .describe("local: R1 and R2, 0.001 HBAR. full: all four rules, 0.005 HBAR."),
        journal: z
          .enum(["sync", "async"])
          .default("sync")
          .describe(
            "sync waits for the verdict to be written to Hedera and returns its sequence number (~4s). " +
              "async answers sooner (~2.4s) and returns status queued.",
          ),
      },
    },
    async ({ transaction, route, journal }) => {
      if (config.payer === null) {
        return json({
          error: "payer_not_configured",
          message: "No Hedera account is configured, so this server cannot pay for a verdict.",
          setup: config.setupHint ?? "",
        });
      }

      const payer = config.payer;
      const before = payer.spent;

      let response: Response;
      try {
        response = await payer.fetch(`${config.baseUrl}/verdict/${route}?journal=${journal}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ transaction }),
        });
      } catch (error) {
        if (error instanceof BudgetExceededError || (error as Error)?.name === "BudgetExceededError") {
          const exceeded = error as BudgetExceededError;
          return json({
            error: "session_budget_exceeded",
            message: exceeded.message,
            spent: formatTinybars(exceeded.spent),
            budget: formatTinybars(exceeded.budget),
            asked: formatTinybars(exceeded.asked),
            what_to_do: "Do not sign. No verdict was obtained. Tell your user the session budget is spent.",
          });
        }
        return json({
          error: "payment_failed",
          message: error instanceof Error ? error.message : String(error),
          what_to_do: "Do not sign. No verdict was obtained.",
        });
      }

      const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (!response.ok || body === null) {
        return json({
          error: "verdict_not_returned",
          status: response.status,
          body,
          what_to_do: "Do not sign. No verdict was obtained.",
        });
      }

      const tier = (body["verdict"] as { tier?: string } | undefined)?.tier;
      return json({
        ...body,
        what_to_do: tier !== undefined && WHAT_TO_DO[tier] !== undefined
          ? WHAT_TO_DO[tier]
          : "Unrecognised tier. Do not sign.",
        spend: {
          this_call: formatTinybars(payer.spent - before),
          session_total: formatTinybars(payer.spent),
          session_remaining: payer.remaining === null ? "unlimited" : formatTinybars(payer.remaining),
        },
      });
    },
  );

  return server;
}
