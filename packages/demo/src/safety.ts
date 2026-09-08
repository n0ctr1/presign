/**
 * False positives, measured against contracts nobody disputes.
 *
 * `idea.md` lists this as a risk in its own words: a scanner that marks
 * ordinary contracts as dangerous is worse than one with narrow coverage,
 * because the first thing an operator does with a verdict they have learned to
 * distrust is ignore it. The risk was written down and never tested, which is
 * the worst combination — a known hazard with no instrument pointed at it.
 *
 * R4 is the reason it matters now. It is the one rule whose finding is an
 * *absence*, so by construction it leans towards flagging whatever it cannot
 * corroborate. If the registry's coverage is thinner than assumed, R4 turns
 * that gap into risk and says so about contracts holding billions.
 *
 * Every address below is a mainnet contract in daily use by ordinary people.
 * The bar is not "no findings" — several are upgradeable proxies and saying so
 * is correct — the bar is that **none of them reaches `high`**, because `high`
 * means do not sign, and refusing a transfer to WETH would end the argument
 * for this project rather than support it.
 */

import { PresignPipeline } from "@presign/gateway";
import type { UnsignedTransaction, Verdict } from "@presign/verdict-engine";

import { buildWiring } from "./wiring.js";

interface Subject {
  readonly name: string;
  readonly address: string;
  /** Why this one is beyond dispute, so the list cannot drift into guesses. */
  readonly why: string;
}

/**
 * Contracts chosen for being uncontroversial rather than convenient.
 *
 * Mixed deliberately: immutable ones (WETH, Multicall3) and upgradeable ones
 * (USDC, USDT), protocols the registry indexes well (Aave, Uniswap) and
 * infrastructure it has little reason to index at all (Multicall3, Permit2).
 * The second kind is where a rule that treats absence as risk will show it.
 */
const SUBJECTS: readonly Subject[] = [
  { name: "WETH9", address: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", why: "immutable since 2017, the most-held contract on Ethereum" },
  { name: "USDC", address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", why: "Circle's token, upgradeable by design" },
  { name: "USDT", address: "0xdac17f958d2ee523a2206206994597c13d831ec7", why: "Tether's token" },
  { name: "DAI", address: "0x6b175474e89094c44da98b954eedeac495271d0f", why: "MakerDAO's stablecoin, immutable" },
  { name: "Aave V3 Pool", address: "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2", why: "largest lending market" },
  { name: "Uniswap V3 Router 2", address: "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45", why: "the router most swaps go through" },
  { name: "Uniswap V3 Factory", address: "0x1f98431c8ad98523631ae4a59f267346ea31f984", why: "immutable factory" },
  { name: "Lido stETH", address: "0xae7ab96520de3a18e5e111b5eaab095312d7fe84", why: "largest liquid staking token" },
  { name: "Curve 3pool", address: "0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7", why: "immutable, long-standing stable pool" },
  { name: "Multicall3", address: "0xca11bde05977b3631167028862be2a173976ca11", why: "immutable utility deployed on every chain; nobody indexes it" },
  { name: "Permit2", address: "0x000000000022d473030f116ddee9f6b43ac78ba3", why: "Uniswap's immutable approval contract" },
  { name: "ENS Registry", address: "0x00000000000c2e074ec69a0dfb2997ba6c7d2e1e", why: "immutable ENS root" },
];

const AGENT = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";

const call = (to: string): UnsignedTransaction =>
  ({ from: AGENT, to, value: 0n, data: "0x", chainId: 1 }) as UnsignedTransaction;

function describe(verdict: Verdict): string {
  const rules = verdict.findings
    .filter((f) => f.severity !== "info")
    .map((f) => `${f.ruleId}/${f.severity}`);
  return rules.length === 0 ? "" : rules.join(" ");
}

/**
 * End the process explicitly.
 *
 * The Substreams stream does not always release its socket when aborted, so
 * closing the wiring is not enough: the work finishes, the table prints, and
 * node sits in the event loop with nothing left to do. That reads as a hang,
 * and diagnosing it as one cost real time more than once. The scenario runner
 * has always exited this way; this says why.
 */
function exit(code: number): never {
  process.exit(code);
}

async function main(): Promise<void> {
  console.log("Starting mainnet fork and subgraph registry…");
  const wiring = await buildWiring();
  const pipeline = new PresignPipeline({ engine: wiring.engine });
  console.log(`Fork ready at block ${wiring.forkBlock}.\n`);

  const line = "─".repeat(78);
  console.log(`${"contract".padEnd(24)} ${"tier".padEnd(12)} rules above info`);
  console.log(line);

  const tiers = new Map<string, number>();
  const failures: { subject: Subject; verdict: Verdict }[] = [];

  try {
    for (const subject of SUBJECTS) {
      const { verdict } = await pipeline.run(call(subject.address));
      tiers.set(verdict.tier, (tiers.get(verdict.tier) ?? 0) + 1);
      console.log(
        `${subject.name.padEnd(24)} ${verdict.tier.padEnd(12)} ${describe(verdict)}`,
      );
      if (verdict.tier === "high") failures.push({ subject, verdict });
    }
  } finally {
    wiring.close();
  }

  console.log(line);
  console.log(
    [...tiers].map(([tier, count]) => `${tier}: ${count}`).join("   "),
  );

  if (failures.length > 0) {
    console.log(`\n${failures.length} contract(s) reached HIGH — the agent would refuse them:\n`);
    for (const { subject, verdict } of failures) {
      console.log(`  ${subject.name} (${subject.address})`);
      console.log(`    ${subject.why}`);
      for (const finding of verdict.findings) {
        if (finding.severity === "critical") {
          console.log(`    · ${finding.ruleId}: ${finding.title}`);
          console.log(`      ${finding.detail.replace(/\s+/g, " ").slice(0, 200)}`);
        }
      }
    }
    // A non-zero exit so this can gate a release rather than be read and
    // shrugged at. Refusing WETH is not a smaller problem than missing a rug.
    exit(1);
  }

  console.log("\nNone reached high. Medium on an upgradeable proxy is correct, not a false positive.");
  exit(0);
}

await main();
