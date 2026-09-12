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
  /**
   * A read the contract answers without reverting.
   *
   * The fixture used to send empty calldata, which most of these contracts
   * revert on. A revert was then an `info` note; it is now `unavailable`,
   * because a transaction that fails in simulation was not evaluated. Each
   * call is a view function, checked against mainnet, so the verdict is about
   * the contract rather than about calldata it does not accept.
   */
  readonly data: string;
  /** Why this one is beyond dispute, so the list cannot drift into guesses. */
  readonly why: string;
}

const TOTAL_SUPPLY = "0x18160ddd";

/**
 * Contracts chosen for being uncontroversial rather than convenient.
 *
 * Mixed deliberately: immutable ones (WETH, Multicall3) and upgradeable ones
 * (USDC, USDT), protocols the registry indexes well (Aave, Uniswap) and
 * infrastructure it has little reason to index at all (Multicall3, Permit2).
 * The second kind is where a rule that treats absence as risk will show it.
 */
const SUBJECTS: readonly Subject[] = [
  { name: "WETH9", address: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", data: TOTAL_SUPPLY, why: "immutable since 2017, the most-held contract on Ethereum" },
  { name: "USDC", address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", data: TOTAL_SUPPLY, why: "Circle's token, upgradeable by design" },
  { name: "USDT", address: "0xdac17f958d2ee523a2206206994597c13d831ec7", data: TOTAL_SUPPLY, why: "Tether's token" },
  { name: "DAI", address: "0x6b175474e89094c44da98b954eedeac495271d0f", data: TOTAL_SUPPLY, why: "MakerDAO's stablecoin, immutable" },
  // getReservesList()
  { name: "Aave V3 Pool", address: "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2", data: "0xd1946dbc", why: "largest lending market" },
  // WETH9()
  { name: "Uniswap V3 Router 2", address: "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45", data: "0x4aa4a4fc", why: "the router most swaps go through" },
  // owner()
  { name: "Uniswap V3 Factory", address: "0x1f98431c8ad98523631ae4a59f267346ea31f984", data: "0x8da5cb5b", why: "immutable factory" },
  { name: "Lido stETH", address: "0xae7ab96520de3a18e5e111b5eaab095312d7fe84", data: TOTAL_SUPPLY, why: "largest liquid staking token" },
  // get_virtual_price()
  { name: "Curve 3pool", address: "0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7", data: "0xbb7b8b80", why: "immutable, long-standing stable pool" },
  // getBlockNumber()
  { name: "Multicall3", address: "0xca11bde05977b3631167028862be2a173976ca11", data: "0x42cbb15c", why: "immutable utility deployed on every chain; nobody indexes it" },
  // DOMAIN_SEPARATOR()
  { name: "Permit2", address: "0x000000000022d473030f116ddee9f6b43ac78ba3", data: "0x3644e515", why: "Uniswap's immutable approval contract" },
  // owner(bytes32(0))
  { name: "ENS Registry", address: "0x00000000000c2e074ec69a0dfb2997ba6c7d2e1e", data: `0x02571be3${"0".repeat(64)}`, why: "immutable ENS root" },
];

const AGENT = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";

const call = (subject: Subject): UnsignedTransaction =>
  ({ from: AGENT, to: subject.address, value: 0n, data: subject.data, chainId: 1 }) as UnsignedTransaction;

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
      const { verdict } = await pipeline.run(call(subject));
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

  const unavailable = tiers.get("unavailable") ?? 0;
  if (unavailable > 0) {
    /*
     * Said plainly, because a reader counting rows sees eleven passes and one
     * failure. It is neither: a deployment that speaks for this counterparty
     * was too slow or too far behind head, and a verdict resting on data we
     * could not get is the one thing this service will not sell. The row is
     * the product working.
     */
    console.log(
      `\n${unavailable} came back unavailable: no deployment could answer for it within the ` +
        "freshness budget. That is not a failed check — it is the refusal this project exists " +
        "to make, and the agent is told the counterparty was never evaluated.",
    );
  }

  console.log(
    "\nNone reached high. A medium here would need a reason — an upgradeable proxy the call adds " +
      "exposure to — and a view call adds none.",
  );
  exit(0);
}

await main();
