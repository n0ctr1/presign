/**
 * End-to-end verdict latency, measured rather than assumed.
 *
 * The plan set a one-second budget and the README reported per-component
 * numbers — liveness 173 ms, conformance 394 ms, a warm resolve under a
 * millisecond. Those are real and they are not an answer: a verdict is a fork
 * simulation plus four rules plus whatever the indexed ones fetch, and the sum
 * of parts measured separately on one day is not the latency anybody
 * experiences. Quoting component timings for a whole-system claim is the kind
 * of number this project spends its time objecting to elsewhere.
 *
 * Three shapes are timed because they cost different things:
 *
 *   - an indexed protocol, where R3 discovers, probes and queries;
 *   - a plain token, where R1 and R2 read the diff and storage slots and R3
 *     finds a counterparty it cannot speak for;
 *   - a contract deployed minutes ago, where R4 pays for a bisection over
 *     historical `eth_getCode`.
 *
 * Cold and warm are reported apart. A warm figure alone flatters the system,
 * and a cold one alone condemns it; an operator needs both because the first
 * request after a deploy is the cold one.
 */

import { PresignPipeline } from "@presign/gateway";
import type { UnsignedTransaction } from "@presign/verdict-engine";

import { buildWiring } from "./wiring.js";

const AGENT = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const AAVE_V3_POOL = "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2";
const UNISWAP_V3_FACTORY = "0x1f98431c8ad98523631ae4a59f267346ea31f984";

/**
 * A view call each counterparty answers without reverting. Empty calldata
 * reverts on most contracts, and a revert is now `unavailable` — timing a
 * refusal would measure the wrong path.
 */
const call = (to: string, data = "0x"): UnsignedTransaction =>
  ({ from: AGENT, to, value: 0n, data, chainId: 1 }) as UnsignedTransaction;

const GET_RESERVES_LIST = "0xd1946dbc";
const TOTAL_SUPPLY = "0x18160ddd";
const OWNER = "0x8da5cb5b";

/** Median rather than mean: one slow gateway call should not move the figure. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

async function time(run: () => Promise<unknown>): Promise<number> {
  const started = performance.now();
  await run();
  return performance.now() - started;
}

async function main(): Promise<void> {
  const repeats = Number(process.env["REPEATS"] ?? 5);

  console.log("Starting mainnet fork and subgraph registry…");
  const wiring = await buildWiring();
  const pipeline = new PresignPipeline({ engine: wiring.engine });
  console.log(`Fork ready at block ${wiring.forkBlock}.\n`);

  try {
    const fresh = await wiring.findRecentDeployment();

    const cases: { name: string; transaction: UnsignedTransaction; note: string }[] = [
      { name: "Aave V3 Pool", transaction: call(AAVE_V3_POOL, GET_RESERVES_LIST), note: "R3 discovers, probes and queries" },
      { name: "USDC", transaction: call(USDC, TOTAL_SUPPLY), note: "R1, R2 and a counterparty R3 cannot speak for" },
      {
        name: "Uniswap V3 Factory",
        transaction: call(UNISWAP_V3_FACTORY, OWNER),
        // Kept in deliberately. This is the slowest counterparty measured, and
        // hiding it would leave a latency claim resting on the easy cases.
        note: "the slow end: a DEX subgraph answering in seconds, not milliseconds",
      },
      ...(fresh === null
        ? []
        : [{ name: "fresh contract", transaction: call(fresh), note: "R4 bisects historical eth_getCode" }]),
    ];

    const line = "─".repeat(78);
    console.log(`${"case".padEnd(22)} ${"cold".padStart(9)} ${"warm p50".padStart(9)} ${"warm min".padStart(9)} ${"warm max".padStart(9)}   what it pays for`);
    console.log(line);

    for (const testCase of cases) {
      const cold = await time(() => pipeline.run(testCase.transaction));
      const warm: number[] = [];
      for (let i = 0; i < repeats; i += 1) {
        warm.push(await time(() => pipeline.run(testCase.transaction)));
      }
      const ms = (value: number) => `${value.toFixed(0)} ms`.padStart(9);
      console.log(
        `${testCase.name.padEnd(22)} ${ms(cold)} ${ms(median(warm))} ${ms(Math.min(...warm))} ${ms(Math.max(...warm))}   ${testCase.note}`,
      );
    }

    console.log(line);
    console.log(`cold = first verdict for that counterparty; warm = ${repeats} repeats after it.`);
    console.log(
      "Funded by " +
        (process.env["GATEWAY_FUNDING"] === "x402"
          ? "x402, where payments are serialised: probes that would overlap queue instead."
          : "the Studio key. GATEWAY_FUNDING=x402 measures the paid path, which is slower by design."),
    );
  } finally {
    wiring.close();
  }

  /*
   * Explicit exit, for the same reason the scenario runner has one: the
   * Substreams stream does not always release its socket when aborted, so a
   * finished run otherwise sits in the event loop looking like a hang.
   */
  process.exit(0);
}

await main();
