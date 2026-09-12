/**
 * @presign/service
 *
 * x402-gated verdict service: an agent pays per call, priced by the data the
 * verdict actually buys.
 */

export { createApp, publicRequest, FACILITATORS } from "./app.js";
export type { DemoOptions, HealthSource, HederaNetwork, ServiceOptions } from "./app.js";
export { parseJournalMode, type JournalMode } from "./app.js";
export {
  parseRules,
  quote,
  formatHbar,
  BASE_TINYBARS,
  INDEXED_DATA_TINYBARS,
  RULE_IDS,
  createMeter,
  meteredQuote,
  MAX_PRICED_DEPLOYMENTS,
  PER_DEPLOYMENT_TINYBARS,
} from "./pricing.js";
export type { Meter, MeteredQuote, MeterOptions, Quote, RuleId } from "./pricing.js";
// Exported so anything else that opens the journal reuses the same topic. A
// second entry point creating its own would fragment the record the first one
// is building, which is the failure this file exists to prevent.
export { readTopicId, writeTopicId } from "./state.js";
export { createRateLimiter, type RateLimiter, type RateLimiterOptions } from "./rate-limit.js";

export { buildRegistryClient, splitArgs } from "./registry.js";

export { DEMO_BUDGETS, DEMO_EXAMPLES, type DemoExample } from "./demo.js";
