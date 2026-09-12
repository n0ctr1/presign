#!/usr/bin/env node
/**
 * An agent that buys a verdict before it signs.
 *
 * This is the consumer side of the x402 flow: no API key, no account, no
 * subscription. The agent discovers the price from a 402, pays in HBAR, and
 * gets the verdict — the whole exchange machine to machine.
 *
 * The point of the demonstration is the *decision*, not the payment: the agent
 * spends a fraction of a cent to find out whether it is about to grant an
 * unlimited approval, and refuses to sign when the answer is yes.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { decodePaymentResponseHeader } from "@x402/fetch";
import { createPayer, parseHederaNetwork, resolveKey } from "@presign/payer";

const SECRETS = join(homedir(), ".presign", "secrets");
const readSecret = async (name: string) =>
  (await readFile(join(SECRETS, name), "utf8")).trim();

const UNLIMITED = "f".repeat(64);
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const SPENDER = "0x00000000000000000000000000000000deadbeef";

async function main(): Promise<void> {
  const base = process.env["PRESIGN_URL"] ?? "http://127.0.0.1:4021";
  const { network, short } = parseHederaNetwork(process.env["HEDERA_NETWORK"]);

  const accountId = await readSecret(`hedera__${short}-agent-id`);
  const privateKey = await resolveKey(
    await readSecret(`hedera__${short}-agent-key`),
    accountId,
    network,
  );

  console.log(`agent ${accountId} on ${network}`);

  // Free: what the verdict will cost, before committing to buy one.
  const quote = (await (await fetch(`${base}/quote`)).json()) as Record<string, unknown>;
  console.log("\nquote:", JSON.stringify(quote["routes"], null, 1));

  /*
   * The paying client lives in @presign/payer, shared with the verdict MCP
   * server, so the key resolution and the spend ceiling are written once. A
   * one-shot agent needs no session budget; the per-payment ceiling of 0.1
   * HBAR still keeps a compromised service from taking more than a verdict is
   * worth, many times over, on this single call.
   */
  const pay = createPayer({ accountId, privateKey, network }).fetch;

  // Default: approve(spender, type(uint256).max) on USDC — the thing worth
  // paying to detect. TARGET=aave asks about a lending pool instead, where R3
  // has protocol data to consult and the indexed-data surcharge buys something.
  const target = process.env["TARGET"] ?? "approve";
  const transaction =
    target === "aave"
      ? {
          from: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
          to: "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2",
          value: "0",
          // getReservesList(): empty calldata reverts on the pool, and a
          // revert is `unavailable`, not a verdict about Aave.
          data: "0xd1946dbc",
          chainId: 1,
        }
      : {
          from: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
          to: USDC,
          value: "0",
          data: `0x095ea7b3${SPENDER.slice(2).padStart(64, "0")}${UNLIMITED}`,
          chainId: 1,
        };

  console.log("\nrequesting a verdict (expect 402, then payment, then answer)…");
  const started = Date.now();
  const response = await pay(`${base}/verdict/${process.env["ROUTE"] ?? "local"}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transaction }),
  });

  if (!response.ok) {
    console.error(`request failed: HTTP ${response.status}`);
    console.error(await response.text());
    process.exit(1);
  }

  const settlement = response.headers.get("payment-response");
  const body = (await response.json()) as {
    decision: string;
    verdict: {
      tier: string;
      action: string;
      findings: { rule: string; title: string; evidence?: Record<string, unknown> }[];
    };
    cost: Record<string, unknown>;
    journal: Record<string, unknown>;
  };

  console.log(`\npaid and answered in ${Date.now() - started}ms`);
  if (settlement !== null) {
    const decoded = decodePaymentResponseHeader(settlement) as Record<string, unknown>;
    console.log("settlement:", JSON.stringify(decoded));
  }

  console.log(`\nVERDICT: ${body.verdict.tier.toUpperCase()} — ${body.decision}`);
  console.log(`  ${body.verdict.action}`);
  for (const finding of body.verdict.findings) {
    console.log(`  · ${finding.rule}: ${finding.title}`);
    // The evidence is the point of paying: a tier alone is a number to trust,
    // while the evidence is something the agent's operator can check.
    const history = (finding as { evidence?: Record<string, unknown> }).evidence?.[
      "upgrade_history"
    ];
    if (history !== undefined) console.log(`      upgrade history: ${JSON.stringify(history)}`);
  }
  console.log("\ncost:", JSON.stringify(body.cost));
  console.log("journal:", JSON.stringify(body.journal));

  // The decision the payment bought. An agent without this signs anyway.
  const signs = body.verdict.tier === "low";
  console.log(`\nagent ${signs ? "SIGNS" : "DOES NOT SIGN"} this transaction.`);
  process.exit(0);
}

await main();
