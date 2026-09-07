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
  RuleOutcome,
  RiskTier,
  Severity,
  StateDiff,
  UnsignedTransaction,
  Verdict,
  VerdictProvenance,
  VerdictSource,
} from "./types.js";

export { evaluated, TIER_ACTION } from "./types.js";

export { AnvilFork, AnvilStartupError, type AnvilForkOptions } from "./simulation/fork.js";
export { ForkSimulator, SimulationError } from "./simulation/simulator.js";
export {
  resolveEthereumRpc,
  describeRpc,
  PUBLIC_ETHEREUM_RPC,
  RPC_SECRET_FILE,
  type ResolvedRpc,
} from "./simulation/rpc-url.js";

export {
  addressCandidates,
  allowanceSlot,
  UnlimitedApprovalRule,
  type UnlimitedApprovalRuleOptions,
} from "./rules/r1-unlimited-approval.js";

export {
  eip1967Slot,
  EIP1967_ADMIN_SLOT,
  EIP1967_BEACON_SLOT,
  EIP1967_IMPLEMENTATION_SLOT,
  humanDuration,
  MutableLogicRule,
  ZEPPELINOS_ADMIN_SLOT,
  ZEPPELINOS_IMPLEMENTATION_SLOT,
  type MutableLogicRuleOptions,
  type UpgradeHistory,
} from "./rules/r2-mutable-logic.js";

export {
  CHAIN_TO_NETWORK,
  InvariantBreachRule,
  type InvariantBreachRuleOptions,
  type ProtocolContext,
} from "./rules/r3-invariant-breach.js";

export {
  OperationalProtocolContext,
  type OperationalProtocolContextOptions,
} from "./protocol/operational-context.js";

export {
  DEFAULT_TIER_POLICY,
  VerdictEngine,
  type TierPolicy,
  type VerdictEngineOptions,
} from "./engine.js";
