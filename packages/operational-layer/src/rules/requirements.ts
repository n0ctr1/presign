/**
 * What each rule needs from indexed data, expressed per schema family.
 *
 * Requirements bind to a **family**, never to a protocol. That is the whole
 * coverage argument: one requirement written once covers every protocol that
 * speaks the schema, so adding a protocol is a configuration change rather
 * than new code.
 *
 * Only R3 appears here, and that is not an omission. R1 reads an approval out
 * of the calldata and the simulated state diff; R2 reads proxy admin and
 * timelock out of storage slots over RPC. Neither touches indexed data at all.
 * R3 — whether a protocol's own invariants still hold — is the one rule that
 * cannot be answered without protocol context, which is precisely why
 * fail-closed on stale context makes indexed data load-bearing by construction
 * rather than by assertion.
 *
 * Every field list below was verified by probing live mainnet deployments, not
 * read off a schema document.
 */

import type { RuleRequirement } from "../types.js";

/**
 * Default freshness budget.
 *
 * Thirty seconds is roughly two Ethereum blocks. Tighter than that and honest
 * deployments fail the budget on ordinary gateway jitter; looser and the data
 * predates the mempool state the transaction is actually about to land in.
 */
export const DEFAULT_MAX_LAG_SECONDS = 30;

/**
 * R3 over a lending market: deposits, borrows and reported TVL must reconcile.
 *
 * Confirmed answering on mainnet by Aave V2, Aave V3, Compound V2, Compound V3
 * and Morpho Blue — five protocols, no protocol-specific code.
 */
export const R3_LENDING: RuleRequirement = {
  ruleId: "R3",
  schemaFamily: "lending-cdp",
  rootField: "markets",
  requiredFields: ["totalValueLockedUSD", "totalBorrowBalanceUSD"],
  maxLagSeconds: DEFAULT_MAX_LAG_SECONDS,
};

/**
 * R3 over an AMM pool: reported TVL must reconcile with the token balances
 * actually held.
 *
 * `outputTokenSupply` is deliberately **not** required. Uniswap V3 does not
 * answer it, and correctly so — its liquidity positions are NFTs, so there is
 * no fungible LP token whose supply could be reported. Requiring it would
 * exclude the largest DEX on the network over a field the invariant does not
 * need, which is how a coverage rule quietly becomes a single-protocol rule.
 *
 * Confirmed answering on mainnet by Curve and Uniswap V3.
 */
export const R3_DEX: RuleRequirement = {
  ruleId: "R3",
  schemaFamily: "dex-amm",
  rootField: "liquidityPools",
  requiredFields: [
    "totalValueLockedUSD",
    "inputTokenBalances",
    "cumulativeVolumeUSD",
  ],
  maxLagSeconds: DEFAULT_MAX_LAG_SECONDS,
};

/**
 * R3 over a yield vault: shares outstanding, price per share and the
 * underlying balance must agree.
 *
 * Confirmed answering on mainnet by Yearn V2.
 */
export const R3_VAULT: RuleRequirement = {
  ruleId: "R3",
  schemaFamily: "yield-vault",
  rootField: "vaults",
  requiredFields: [
    "totalValueLockedUSD",
    "inputTokenBalance",
    "outputTokenSupply",
    "pricePerShare",
  ],
  maxLagSeconds: DEFAULT_MAX_LAG_SECONDS,
};

/** Every requirement the capability index knows how to warm. */
export const RULE_REQUIREMENTS: readonly RuleRequirement[] = [
  R3_LENDING,
  R3_DEX,
  R3_VAULT,
];

/** Look up a requirement by rule and family. */
export function findRequirement(
  ruleId: string,
  schemaFamily: string,
): RuleRequirement | null {
  return (
    RULE_REQUIREMENTS.find(
      (requirement) =>
        requirement.ruleId === ruleId &&
        requirement.schemaFamily === schemaFamily,
    ) ?? null
  );
}
