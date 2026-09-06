/**
 * Works around a Linux-only defect in `@ledgerhq/device-transport-kit-node-hid`.
 *
 * A Ledger exposes several USB HID interfaces. Only the one on usage page
 * `0xFFA0` speaks APDU; the FIDO/U2F interface on `0xF1D0` cannot, and writing
 * an APDU frame to it fails with `ReceiverApduError` — a transport error that
 * says nothing about which interface was chosen.
 *
 * The transport does filter on usage page, but only on macOS and Windows.
 * From its compiled source, with `b = 65440` (`0xFFA0`):
 *
 *     vendorId !== LEDGER ? false
 *       : (platform === "darwin" || platform === "win32") ? usagePage === b
 *       : true
 *
 * On Linux every Ledger HID interface is accepted, so which one gets used is
 * incidental. The upstream tests cover darwin and win32 and have no Linux
 * case, which is presumably why it went unnoticed. The likely reasoning is
 * that Linux hidraw once did not report usage pages reliably — but it does
 * now: node-hid reports `0xffa0` and `0xf1d0` correctly on the device this was
 * found with.
 *
 * A device with U2F disabled exposes one HID interface and works by luck. Ours
 * exposed two, and the transport picked the wrong one.
 *
 * The shim filters `devicesAsync` before the transport sees the list. It is
 * confined to this file and applied once, so removing it after an upstream fix
 * is a single deletion. Reported in docs/feedback/ledger.md.
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const LEDGER_VENDOR_ID = 0x2c97;
/** Ledger's vendor-defined usage page: the only interface that speaks APDU. */
const APDU_USAGE_PAGE = 0xffa0;

interface HidDeviceInfo {
  readonly vendorId?: number;
  readonly usagePage?: number;
  readonly path?: string;
}

interface NodeHidModule {
  devicesAsync?: (...args: unknown[]) => Promise<HidDeviceInfo[]>;
  devices?: (...args: unknown[]) => HidDeviceInfo[];
}

let applied = false;

/**
 * Keep a Ledger interface only when it is the APDU one.
 *
 * A device whose usage page is unknown is kept rather than dropped: on a
 * platform that does not report it, filtering would remove every interface and
 * turn a working setup into "no device found", which is a worse failure than
 * the one being fixed.
 */
function isUsable(device: HidDeviceInfo): boolean {
  if (device.vendorId !== LEDGER_VENDOR_ID) return true;
  if (device.usagePage === undefined || device.usagePage === 0) return true;
  return device.usagePage === APDU_USAGE_PAGE;
}

/**
 * Apply the filter to the shared `node-hid` instance.
 *
 * Idempotent, and a no-op off Linux where the transport already filters
 * correctly — applying it there would be harmless but would hide whether the
 * upstream fix has landed.
 */
export function applyLedgerHidFilter(): boolean {
  if (applied || process.platform !== "linux") return false;

  const hid = require("node-hid") as NodeHidModule;

  const originalAsync = hid.devicesAsync;
  if (typeof originalAsync === "function") {
    hid.devicesAsync = async (...args: unknown[]) =>
      (await originalAsync.apply(hid, args)).filter(isUsable);
  }

  const originalSync = hid.devices;
  if (typeof originalSync === "function") {
    hid.devices = (...args: unknown[]) =>
      originalSync.apply(hid, args).filter(isUsable);
  }

  applied = true;
  return true;
}

/** Exposed for tests. */
export const __testing = { isUsable, APDU_USAGE_PAGE, LEDGER_VENDOR_ID };
