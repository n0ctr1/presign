/**
 * @presign/verdict-engine
 *
 * Turns an unsigned transaction into a risk verdict, by running it and reading
 * what it actually changed.
 */

export type {
  AccountDiff,
  Address,
  Finding,
  Hex,
  Rule,
  RuleContext,
  RiskTier,
  Severity,
  StateDiff,
  UnsignedTransaction,
  Verdict,
  VerdictProvenance,
} from "./types.js";

export { TIER_ACTION } from "./types.js";

export { AnvilFork, AnvilStartupError, type AnvilForkOptions } from "./simulation/fork.js";
export { ForkSimulator, SimulationError } from "./simulation/simulator.js";

export {
  addressCandidates,
  allowanceSlot,
  UnlimitedApprovalRule,
  type UnlimitedApprovalRuleOptions,
} from "./rules/r1-unlimited-approval.js";
