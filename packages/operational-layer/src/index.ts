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
  GatewayClient,
  GatewayQueryError,
  type GatewayClientOptions,
} from "./gateway/client.js";

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
