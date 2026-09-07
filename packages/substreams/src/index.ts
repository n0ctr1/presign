/**
 * @presign/substreams
 *
 * History that state reads cannot provide: when a proxy's logic last changed.
 */

export {
  ProxyUpgradeIndex,
  SubstreamsError,
  toUpgradeRecord,
  ETHEREUM_COMMON_SPKG,
  MAINNET_ENDPOINT,
  UPGRADED_TOPIC,
} from "./proxy-upgrades.js";
export type {
  ProxyUpgradeIndexOptions,
  StreamedEvent,
  UpgradeRecord,
} from "./proxy-upgrades.js";
