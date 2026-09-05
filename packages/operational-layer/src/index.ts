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
  ConformanceReport,
  DeploymentCandidate,
  DeploymentId,
  DeploymentRecord,
  DiscoverySource,
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
export { ConformanceProbe, type FieldRequirement } from "./probes/conformance.js";
