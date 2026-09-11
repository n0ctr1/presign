/**
 * @presign/hedera
 *
 * A verdict journal whose timestamps nobody can forge, including us.
 */

export {
  commitTransaction,
  hashTransaction,
  newSalt,
  toEntry,
  InMemoryVerdictJournal,
} from "./journal.js";
export type { JournalEntry, JournalReceipt, VerdictJournal } from "./journal.js";

export { HcsVerdictJournal, HcsJournalError, resolveOperatorKey } from "./hcs-journal.js";
export type { HederaNetwork, HcsVerdictJournalOptions } from "./hcs-journal.js";
