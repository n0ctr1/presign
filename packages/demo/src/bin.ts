#!/usr/bin/env node
/**
 * End-to-end demonstration.
 *
 *   npm run demo                 verdicts only
 *   npm run demo -- --device     medium tier escalates to a real Ledger
 *   npm run demo -- --paid       real money both ways: the agent buys the
 *                                verdict in HBAR, the verdict buys its data
 *                                in USDC
 *
 * The last two scenarios are the same transaction under different freshness
 * budgets. That pair is the claim this project makes: when fresh context
 * cannot be obtained the answer is `unavailable`, and `unavailable` is not a
 * softer way of saying `low`.
 */

import { PresignPipeline, describe, type ConfirmationRequester } from "@presign/gateway";
import type { UnsignedTransaction, Verdict } from "@presign/verdict-engine";

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { buildWiring } from "./wiring.js";
import { runTwoSided } from "./two-sided.js";

const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const AAVE_V3_POOL = "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2";
const AGENT = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
/**
 * An address on ScamSniffer's public blacklist, checked against the list at
 * run time rather than trusted from this line.
 */
const FLAGGED_SPENDER = "0x43412801d29861ecc4c4d86e5becfd16af86a67b";
/** Uniswap's Permit2: an ordinary spender no list has reason to name. */
const PERMIT2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";

const approve = (spender: string, amountHex: string): UnsignedTransaction => ({
  from: AGENT as never,
  to: USDC as never,
  value: 0n,
  data: `0x095ea7b3${spender.slice(2).padStart(64, "0")}${amountHex}` as never,
  chainId: 1,
});

/**
 * A call with calldata the counterparty accepts. Empty calldata reverts on the
 * Aave pool, and a revert is `unavailable` — not evaluated — so the healthy
 * protocol scenario reads the reserve list, a view any caller may send.
 */
const call = (to: string, data = "0x"): UnsignedTransaction => ({
  from: AGENT as never,
  to: to as never,
  value: 0n,
  data: data as never,
  chainId: 1,
});

/** `getReservesList()` on the Aave V3 pool. */
const GET_RESERVES_LIST = "0xd1946dbc";

/**
 * Print the heading, then run, then print the outcome.
 *
 * The ordering is not cosmetic. Device progress is logged while the scenario
 * runs, so printing the heading afterwards put those lines under the *previous*
 * scenario — which made it look as though the refused high-risk transaction had
 * reached the device, the exact opposite of what this demo demonstrates.
 */
async function scenario(
  title: string,
  note: string,
  run: () => Promise<{ verdict: Verdict } & Record<string, unknown>>,
): Promise<void> {
  const line = "\u2500".repeat(72);
  console.log(`\n${line}\n${title}\n${note}\n${line}`);

  const outcome = await run();

  console.log(describe(outcome as never));
  // The reason code alone is not actionable. A demo that says "device_error"
  // without saying why sends a reviewer looking in the wrong place.
  if (typeof outcome["detail"] === "string" && outcome["detail"] !== "") {
    console.log(`  detail: ${outcome["detail"]}`);
  }
  for (const finding of outcome.verdict.findings) {
    console.log(`  [${finding.severity}] ${finding.ruleId}: ${finding.title}`);
  }
  const { sources, unavailableRules, simulatedAtBlock } = outcome.verdict.provenance;
  console.log(
    simulatedAtBlock === null
      ? "  provenance: not simulated"
      : `  provenance: simulated at block ${simulatedAtBlock}`,
  );
  for (const source of sources) {
    console.log(
      `    source ${source.displayName} (${source.deploymentId.slice(0, 12)}\u2026) lag ${source.effectiveLagSeconds}s`,
    );
  }
  for (const rule of unavailableRules) {
    console.log(`    UNAVAILABLE ${rule.ruleId}: ${rule.reason}`);
  }
}

async function main(): Promise<void> {
  const useDevice = process.argv.includes("--device");
  /*
   * `--paid` turns on both directions of real payment at once.
   *
   * Off by default because a demo should not spend somebody's money for
   * being run. On, it funds gateway queries with x402 on Base and adds a
   * final scenario where an agent buys a verdict from us in HBAR — so one
   * transaction produces both numbers, with settlement hashes on two chains.
   */
  const paid = process.argv.includes("--paid");
  if (paid) process.env["GATEWAY_FUNDING"] = "x402";

  console.log("Starting mainnet fork and subgraph registry…");
  const wiring = await buildWiring();
  console.log(`Fork ready at block ${wiring.forkBlock}.`);

  let confirmation: ConfirmationRequester | undefined;
  let closeDevice: (() => Promise<void>) | undefined;

  if (useDevice) {
    // Imported lazily so the demo runs on a machine with no Ledger packages
    // resolvable at all.
    const { LedgerDevice, DeviceConfirmation } = await import("@presign/ledger");
    console.log("Connecting to Ledger…");
    const device = await LedgerDevice.connect({ discoveryTimeoutMs: 5_000 });
    console.log(`Connected: ${device.name} (${device.model})`);
    const inner = new DeviceConfirmation({
      device,
      onProgress: (step) => console.log(`    [device] ${step}`),
    });
    confirmation = inner as unknown as ConfirmationRequester;
    closeDevice = () => device.disconnect();
  }

  const pipeline = new PresignPipeline({
    engine: wiring.engine,
    ...(confirmation === undefined ? {} : { confirmation }),
  });
  const strict = new PresignPipeline({ engine: wiring.strictEngine });

  try {
    await scenario(
      "1. Unlimited USDC approval to an address on ScamSniffer's blacklist",
      wiring.incidents.has(FLAGGED_SPENDER)
        ? `   ${FLAGGED_SPENDER} is on the list as fetched just now.\n` +
            "   Expect: refused, without ever reaching the device."
        : `   ${FLAGGED_SPENDER} is NOT on the list as fetched (or the list did not load),\n` +
            "   so expect medium rather than high: R1 escalates only what the list names.",
      () => pipeline.run(approve(FLAGGED_SPENDER, "f".repeat(64))),
    );

    const bounded = approve(
      PERMIT2,
      (1000n * 10n ** 6n).toString(16).padStart(64, "0"),
    );
    await scenario(
      "2. Bounded approval (1000 USDC) to Permit2, an ordinary spender",
      useDevice
        ? "   Expect: medium \u2014 LOOK AT THE LEDGER and approve or reject."
        : "   Expect: medium \u2014 human confirmation required (run with --device to try it).",
      () =>
        pipeline.run(bounded, {
          ...bounded,
          nonce: 0,
          gasLimit: 100_000n,
          maxFeePerGas: 30_000_000_000n,
          maxPriorityFeePerGas: 1_000_000_000n,
        }),
    );

    await scenario(
      "3. Call to Aave V3 Pool \u2014 healthy protocol, fresh indexed data",
      "   Expect: low, with the deployment and its lag named.",
      () => pipeline.run(call(AAVE_V3_POOL, GET_RESERVES_LIST)),
    );

    await scenario(
      "4. The same Aave call under a 1-second freshness budget",
      "   Expect: unavailable. Same protocol, same data, only the budget changed.",
      () => strict.run(call(AAVE_V3_POOL, GET_RESERVES_LIST)),
    );

    /*
     * The case the first three rules are all silent about.
     *
     * Nothing here is contrived: the address is a real contract deployed on
     * mainnet minutes before the fork block, found by walking back from it.
     * R1 sees no approval, R2 finds no proxy, R3 finds no protocol to check —
     * and before R4 existed those three silences added up to `low`.
     */
    const fresh = await wiring.findRecentDeployment();
    if (fresh === null) {
      console.log(
        "\n(no contract creation in the forty blocks before the fork block, " +
          "so the unidentified-counterparty scenario is skipped)",
      );
    } else {
      await scenario(
        `5. Call to ${fresh} — deployed minutes ago, indexed by nobody`,
        "   Expect: high. R1, R2 and R3 all find nothing; that is the point.",
        () => pipeline.run(call(fresh)),
      );
    }

    /*
     * What the verdicts cost us upstream.
     *
     * Printed only when there is something to print, which is the honest
     * shape: on a Studio plan the per-query cost is real but billed monthly,
     * so this process cannot see it and says nothing rather than reporting a
     * zero it would be inventing.
     */
    if (paid) {
      await runTwoSided({
        engine: wiring.engine,
        localEngine: wiring.localEngine,
        ledger: wiring.ledger,
        chainIds: [wiring.chainId],
        secret: async (name) => {
          try {
            return (
              await readFile(join(homedir(), ".presign", "secrets", name), "utf8")
            ).trim();
          } catch {
            return null;
          }
        },
        // Aave, so the verdict actually needs indexed protocol data. A
        // transaction R1 and R2 could settle on their own would produce a
        // clean verdict and an upstream cost of nothing, which demonstrates
        // the plumbing while hiding the point.
        transaction: {
          from: AGENT,
          to: AAVE_V3_POOL,
          value: "0",
          data: GET_RESERVES_LIST,
          chainId: 1,
        },
      });
    }

    const payments = wiring.ledger.payments;
    if (payments.length > 0) {
      const line = "\u2500".repeat(72);
      console.log(`\n${line}\nUpstream cost of the verdicts above\n${line}`);
      for (const payment of payments) {
        console.log(
          `  ${payment.display}  ${payment.deploymentId}  ${payment.transaction ?? "(no settlement ref)"}`,
        );
      }
      console.log(`  total: ${JSON.stringify(wiring.ledger.totals())}`);
    }

  } finally {
    await closeDevice?.();
    wiring.close();
  }

  console.log("\nDone.");
  process.exit(0);
}

await main();
