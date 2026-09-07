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

import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment, decodePaymentResponseHeader } from "@x402/fetch";
// PrivateKey comes from @x402/hedera rather than @hashgraph/sdk: the x402
// packages build on @hiero-ledger/sdk, the renamed Hedera SDK, and the two
// declare structurally identical but nominally distinct key types. Importing
// from the package that will consume the key avoids the mismatch entirely.
import { createClientHederaSigner, PrivateKey } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";

const SECRETS = join(homedir(), ".presign", "secrets");
const readSecret = async (name: string) =>
  (await readFile(join(SECRETS, name), "utf8")).trim();

/** Hedera portals hand out ECDSA keys as 0x-prefixed hex; the SDK wants them bare. */
function parseKey(raw: string): PrivateKey {
  const hex = raw.startsWith("0x") ? raw.slice(2) : raw;
  return /^[0-9a-fA-F]{64}$/.test(hex)
    ? PrivateKey.fromStringECDSA(hex)
    : PrivateKey.fromStringDer(raw);
}

const UNLIMITED = "f".repeat(64);
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const SPENDER = "0x00000000000000000000000000000000deadbeef";

async function main(): Promise<void> {
  const base = process.env["PRESIGN_URL"] ?? "http://127.0.0.1:4021";
  const network = process.env["HEDERA_NETWORK"] ?? "hedera:testnet";
  const short = network === "hedera:mainnet" ? "mainnet" : "testnet";

  const accountId = await readSecret(`hedera__${short}-agent-id`);
  const privateKey = parseKey(await readSecret(`hedera__${short}-agent-key`));

  console.log(`agent ${accountId} on ${network}`);

  // Free: what the verdict will cost, before committing to buy one.
  const quote = (await (await fetch(`${base}/quote`)).json()) as Record<string, unknown>;
  console.log("\nquote:", JSON.stringify(quote["routes"], null, 1));

  const signer = createClientHederaSigner(accountId, privateKey, { network });

  /*
   * Spend controls, set deliberately rather than switched off.
   *
   * The client refuses by default to pay in anything outside its known-asset
   * list, which on Hedera means USDC — so a request priced in native HBAR is
   * rejected until the agent explicitly permits it. That default is the same
   * instinct this whole project is built on: an agent should not hand over
   * value just because something asked it to.
   *
   * So HBAR is allowed by name, with a hard per-payment ceiling, rather than
   * passing `allowedAssets: true` or `spendControls: false`. A verdict costs
   * 0.005 HBAR; a cap of 0.1 leaves room for price changes while keeping a
   * compromised or misconfigured service from draining the account one call
   * at a time.
   */
  const client = new x402Client()
    .setSpendControls({
      allowedAssets: [
        {
          network: network as `${string}:${string}`,
          asset: "0.0.0",
          maxAmountPerPayment: "10000000", // 0.1 HBAR in tinybars
        },
      ],
    })
    .register("hedera:*", new ExactHederaScheme(signer));
  const pay = wrapFetchWithPayment(fetch, client);

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
          data: "0x",
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
    verdict: { tier: string; action: string; findings: { rule: string; title: string }[] };
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
  }
  console.log("\ncost:", JSON.stringify(body.cost));
  console.log("journal:", JSON.stringify(body.journal));

  // The decision the payment bought. An agent without this signs anyway.
  const signs = body.verdict.tier === "low";
  console.log(`\nagent ${signs ? "SIGNS" : "DOES NOT SIGN"} this transaction.`);
  process.exit(0);
}

await main();
