/**
 * @presign/gateway
 *
 * Composes verdict, escalation policy and human confirmation into a single
 * decision about an unsigned transaction.
 */

export { PresignPipeline, describe } from "./pipeline.js";
export type {
  ConfirmationRequester,
  PipelineDecision,
  PresignPipelineOptions,
  Signature,
} from "./pipeline.js";
