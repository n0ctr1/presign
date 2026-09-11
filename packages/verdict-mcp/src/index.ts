/**
 * @presign/verdict-mcp
 *
 * Lets a model buy a pre-signature verdict over MCP, paying over x402 on
 * Hedera within a session budget.
 */

export { createVerdictServer, WHAT_TO_DO, type VerdictServerConfig } from "./server.js";
export {
  APPROVAL_NONCE,
  commitmentOf,
  DEFAULT_BROKER_POLICY,
  signThroughVerdict,
  type AssessedTransaction,
  type BrokerPolicy,
  type BrokerSession,
  type BrokerAccount,
  type BrokerOptions,
  type ChainReader,
  type HumanApprover,
  type SignatureFields,
  type SignRequest,
  type VerdictPurchase,
} from "./broker.js";
export { rpcChainReader } from "./chain.js";
