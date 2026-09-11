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
  RuleList,
  ValueEffects,
  Verdict,
  VerdictList,
  VerdictProvenance,
  VerdictSource,
} from "./types.js";

export { evaluated, TIER_ACTION } from "./types.js";

export { AnvilFork, AnvilStartupError, type AnvilForkOptions } from "./simulation/fork.js";
export { ForkSimulator, SimulationError } from "./simulation/simulator.js";
export { NO_EFFECTS, valueEffects } from "./simulation/effects.js";
export {
  calldataAddresses,
  mappingEntries,
  MAX_ADDRESS_CANDIDATES,
  MAX_MAPPING_SLOT,
  nestedMappingEntries,
  transactionAddresses,
  type AddressCandidates,
  type MappingEntry,
} from "./simulation/mappings.js";
export {
  resolveEthereumRpc,
  describeRpc,
  PUBLIC_ETHEREUM_RPC,
  RPC_SECRET_FILE,
  type ResolvedRpc,
} from "./simulation/rpc-url.js";

export {
  allowanceSlot,
  UnlimitedApprovalRule,
  type UnlimitedApprovalRuleOptions,
} from "./rules/r1-unlimited-approval.js";

export {
  SCAM_SNIFFER_ADDRESS_LIST,
  ScamSnifferIncidentFeed,
  StaticIncidentRegistry,
  toIncidentRegistry,
  type IncidentRegistry,
  type IncidentRegistryStatus,
  type ScamSnifferFeedOptions,
} from "./incidents/incident-registry.js";

export { exposureGrowth, type ExposureGrowth } from "./rules/exposure.js";
export { plainText, quotedName } from "./rules/untrusted-text.js";
export { LruMap } from "./util/lru-map.js";

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
  confirmedFactory,
  countInvariantCandidates,
  InvariantBreachRule,
  MAX_INVARIANT_CANDIDATES,
  type ConfirmedFactory,
  type InvariantBreachRuleOptions,
  type ProbeOutcome,
  type ProtocolContext,
} from "./rules/r3-invariant-breach.js";

export {
  DEFAULT_FRESH_DEPLOYMENT_SECONDS,
  UnidentifiedCounterpartyRule,
  type CounterpartyDirectory,
  type UnidentifiedCounterpartyRuleOptions,
} from "./rules/r4-unidentified-counterparty.js";

export {
  DEFAULT_HORIZON_SECONDS,
  RpcContractOrigin,
  type ContractOrigin,
  type ContractOriginSource,
  type RpcContractOriginOptions,
} from "./chain/contract-origin.js";

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
