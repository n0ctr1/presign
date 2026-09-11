/**
 * @presign/operational-layer
 *
 * Answers "which deployments can answer this rule right now, within this lag
 * budget" — the question a pre-signature verdict needs and a discovery registry
 * does not answer.
 */

export type {
  CapabilityResolution,
  ChainHeadSource,
  ChainId,
  ConformanceChecker,
  ConformanceReport,
  DeploymentCandidate,
  DeploymentId,
  DeploymentRecord,
  DiscoverySource,
  FieldRequirement,
  LivenessChecker,
  LivenessReport,
  NetworkId,
  RuleId,
  RuleRequirement,
  SchemaFamily,
  UnavailabilityReason,
} from "./types.js";

export {
  RegistryProtocolError,
  SubgraphRegistrySource,
  type RegistryToolCaller,
} from "./registry/client.js";

export {
  REGISTRY_PACKAGE,
  RegistrySubprocess,
  registryEnvironment,
  type RegistrySubprocessOptions,
} from "./registry/subprocess.js";

export {
  GatewayClient,
  GatewayQueryError,
  type GatewayClientOptions,
} from "./gateway/client.js";

export {
  BASE_NETWORK,
  chooseFunding,
  BASE_USDC,
  DEFAULT_MAX_PER_QUERY,
  formatUnits6,
  paymentRefusalReason,
  PaymentLedger,
  StudioKeyFunding,
  X402Funding,
  type ChooseFundingOptions,
  type FundingChoice,
  type GatewayFunding,
  type PaymentRecord,
  type X402FundingOptions,
} from "./gateway/funding.js";

export {
  ChainHeadUnavailableError,
  JsonRpcChainHeadSource,
  type JsonRpcChainHeadOptions,
} from "./chain/rpc.js";

export { LivenessProbe, type LivenessProbeOptions } from "./probes/liveness.js";

export {
  DEFAULT_MAX_LAG_SECONDS,
  findRequirement,
  RULE_REQUIREMENTS,
  R3_DEX,
  R3_LENDING,
  R3_VAULT,
} from "./rules/requirements.js";

export {
  CapabilityIndex,
  effectiveLagSeconds,
  type CapabilityIndexOptions,
} from "./capability/index.js";
export { ConformanceProbe } from "./probes/conformance.js";
