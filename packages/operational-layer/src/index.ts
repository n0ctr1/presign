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
