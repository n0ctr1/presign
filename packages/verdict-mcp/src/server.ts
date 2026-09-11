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

import {
  signThroughVerdict,
  type BrokerAccount,
  type BrokerPolicy,
  type BrokerSession,
  type ChainReader,
  type HumanApprover,
  type VerdictPurchase,
} from "./broker.js";

export interface VerdictServerConfig {
  /** e.g. https://presign.dev */
  readonly baseUrl: string;
  /** Null when no Hedera account is configured; `get_verdict` then explains how. */
  readonly payer: Payer | null;
  /** Shown when the payer is missing, so the model can tell its user what to do. */
  readonly setupHint?: string;
  /** For the free endpoints. Injectable for tests. */
  readonly fetch?: typeof globalThis.fetch;
  /**
   * The agent's signing key and what signing needs. When present the server
   * offers `sign_transaction`, which signs only through a verdict; when absent
   * no signing tool exists at all.
   */
  readonly broker?: {
    readonly account: BrokerAccount;
    readonly chain: ChainReader;
    readonly approver: HumanApprover | null;
    readonly policy: BrokerPolicy;
  } | null;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX = /^0x([0-9a-fA-F]{2})*$/;
const DECIMAL = /^\d+$/;
/** 128 KiB of calldata as hex, past any transaction a block would carry. */
const MAX_DATA_CHARS = 2 + 2 * 128 * 1024;

interface VerdictTransaction {
  readonly from: string;
  readonly to: string | null;
  readonly value: string;
  readonly data: string;
  readonly chainId: number;
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

  /**
   * Buy one verdict. Shared by `get_verdict` and `sign_transaction`, so the
   * budget, the refusals and `what_to_do` are the same whichever tool asked.
   */
  const purchase = async (
    transaction: VerdictTransaction,
    route: "local" | "full",
    journal: "sync" | "async",
  ): Promise<VerdictPurchase> => {
    if (config.payer === null) {
      return {
        ok: false,
        result: {
          error: "payer_not_configured",
          message: "No Hedera account is configured, so this server cannot pay for a verdict.",
          setup: config.setupHint ?? "",
        },
      };
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
        return {
          ok: false,
          result: {
            error: "session_budget_exceeded",
            message: exceeded.message,
            spent: formatTinybars(exceeded.spent),
            budget: formatTinybars(exceeded.budget),
            asked: formatTinybars(exceeded.asked),
            what_to_do: "Do not sign. No verdict was obtained. Tell your user the session budget is spent.",
          },
        };
      }
      return {
        ok: false,
        result: {
          error: "payment_failed",
          message: error instanceof Error ? error.message : String(error),
          what_to_do: "Do not sign. No verdict was obtained.",
        },
      };
    }

    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok || body === null) {
      return {
        ok: false,
        result: {
          error: "verdict_not_returned",
          status: response.status,
          body,
          what_to_do: "Do not sign. No verdict was obtained.",
        },
      };
    }

    const tier = (body["verdict"] as { tier?: string } | undefined)?.tier;
    const result = {
      ...body,
      what_to_do: tier !== undefined && WHAT_TO_DO[tier] !== undefined
        ? WHAT_TO_DO[tier]
        : "Unrecognised tier. Do not sign.",
      spend: {
        this_call: formatTinybars(payer.spent - before),
        session_total: formatTinybars(payer.spent),
        session_remaining: payer.remaining === null ? "unlimited" : formatTinybars(payer.remaining),
      },
    };
    return tier === undefined ? { ok: false, result } : { ok: true, tier, result };
  };

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
            from: z.string().regex(ADDRESS).describe("Sender address, 0x-prefixed."),
            to: z
              .string()
              .regex(ADDRESS)
              .nullable()
              .describe("Recipient or contract, 0x-prefixed; null for contract creation."),
            value: z.string().regex(DECIMAL).default("0").describe("Wei, as a decimal string."),
            data: z.string().regex(HEX).max(MAX_DATA_CHARS).default("0x").describe("Calldata, 0x-prefixed."),
            chainId: z
              .number()
              .int()
              .describe(
                "EVM chain id. Only 1 (Ethereum mainnet) is simulated; any other chain is refused " +
                  "before payment, which means you have no verdict for it.",
              ),
          })
          .describe("The unsigned transaction to judge."),
        route: z
          .enum(["local", "full"])
          .default("full")
          .describe(
            "local: R1 and R2, 0.001 HBAR. full: all four rules, 0.001 HBAR plus 0.001 for each " +
              "indexed deployment the verdict reads, up to 0.009. get_quote prices it first.",
          ),
        journal: z
          .enum(["sync", "async"])
          .default("sync")
          .describe(
            "sync waits for the verdict to be written to Hedera and returns its sequence number (~4s). " +
              "async answers sooner (~2.4s) and returns status queued.",
          ),
      },
    },
    async ({ transaction, route, journal }) =>
      json((await purchase(transaction, route, journal)).result),
  );

  if (config.broker != null) {
    const broker = config.broker;
    // What this server has let out of the wallet since it started.
    const session: BrokerSession = { ethSpentWei: 0n };
    server.registerTool(
      "sign_transaction",
      {
        title: "Sign a transaction, through a verdict and a policy",
        description:
          "Signs with this agent's key, which you never see, and only through a paid verdict on the exact " +
          "transaction and this server's policy. low is signed; medium — and any transaction that sends value " +
          "outside the allowlist, or more than the per-transaction ceiling — is signed only after a human " +
          "approves the decoded transaction on a Ledger, and refused when none is attached; high and " +
          "unavailable are refused. Sender, nonce, gas and fees are chosen by the server, not by you. Nothing " +
          "is broadcast. There is no other way to get a signature from this server, so do not look for one.",
        inputSchema: {
          transaction: z
            .object({
              to: z.string().regex(ADDRESS).nullable().describe("Recipient or contract; null for creation."),
              value: z.string().regex(DECIMAL).default("0").describe("Wei, as a decimal string."),
              data: z.string().regex(HEX).max(MAX_DATA_CHARS).default("0x").describe("Calldata, 0x-prefixed."),
              chainId: z.number().int().describe("Only 1 is evaluated; other chains are refused."),
            })
            .describe("The transaction to sign. No sender, nonce or fees: the server sets them."),
          journal: z.enum(["sync", "async"]).default("sync"),
        },
      },
      async ({ transaction, journal }) =>
        json(
          await signThroughVerdict(
            {
              ...broker,
              session,
              buyVerdict: (assessed) =>
                purchase(
                  {
                    from: assessed.from,
                    to: assessed.to,
                    value: assessed.value.toString(),
                    data: assessed.data,
                    chainId: assessed.chainId,
                  },
                  "full",
                  journal,
                ),
            },
            {
              to: transaction.to as `0x${string}` | null,
              value: BigInt(transaction.value),
              data: transaction.data as `0x${string}`,
              chainId: transaction.chainId,
            },
          ),
        ),
    );
  }
  return server;
}
