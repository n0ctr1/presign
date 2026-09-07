#!/usr/bin/env node
/**
 * End-to-end demonstration.
 *
 *   npm run demo                 verdicts only
 *   npm run demo -- --device     medium tier escalates to a real Ledger
 *
 * The last two scenarios are the same transaction under different freshness
 * budgets. That pair is the claim this project makes: when fresh context
 * cannot be obtained the answer is `unavailable`, and `unavailable` is not a
 * softer way of saying `low`.
 */

import { PresignPipeline, describe, type ConfirmationRequester } from "@presign/gateway";
import type { UnsignedTransaction, Verdict } from "@presign/verdict-engine";

import { buildWiring } from "./wiring.js";

const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const AAVE_V3_POOL = "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2";
const AGENT = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const FLAGGED_SPENDER = "0x00000000000000000000000000000000deadbeef";

const approve = (spender: string, amountHex: string): UnsignedTransaction => ({
  from: AGENT as never,
  to: USDC as never,
  value: 0n,
  data: `0x095ea7b3${spender.slice(2).padStart(64, "0")}${amountHex}` as never,
  chainId: 1,
});

const call = (to: string): UnsignedTransaction => ({
  from: AGENT as never,
  to: to as never,
  value: 0n,
  data: "0x" as never,
  chainId: 1,
});

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
  console.log(`  provenance: simulated at block ${simulatedAtBlock}`);
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
      "1. Unlimited USDC approval to a spender in the incident registry",
      "   Expect: refused, without ever reaching the device.",
      () => pipeline.run(approve(FLAGGED_SPENDER, "f".repeat(64))),
    );

    const bounded = approve(
      FLAGGED_SPENDER,
      (1000n * 10n ** 6n).toString(16).padStart(64, "0"),
    );
    await scenario(
      "2. Bounded approval (1000 USDC) to the same spender",
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
      () => pipeline.run(call(AAVE_V3_POOL)),
    );

    await scenario(
      "4. The same Aave call under a 1-second freshness budget",
      "   Expect: unavailable. Same protocol, same data, only the budget changed.",
      () => strict.run(call(AAVE_V3_POOL)),
    );

  } finally {
    await closeDevice?.();
    wiring.close();
  }

  console.log("\nDone.");
  process.exit(0);
}

await main();
