/**
 * @presign/ledger
 *
 * Escalates a medium-risk verdict to on-device human confirmation. The device
 * holds the key; this process never does.
 */

export { LedgerDevice, DeviceUnavailableError } from "./device.js";
export type { DiscoveredDevice, LedgerDeviceOptions } from "./device.js";

export { decideEscalation } from "./escalation.js";
export type { EscalationDecision } from "./escalation.js";

export {
  DeviceConfirmation,
  DEFAULT_DERIVATION_PATH,
} from "./confirmation.js";
export type {
  ConfirmationResult,
  DeviceConfirmationOptions,
  Signature,
  SignableTransaction,
  TransactionSigner,
} from "./confirmation.js";

export { applyLedgerHidFilter } from "./hid-filter.js";
