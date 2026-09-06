/**
 * Runtime interop for the Device Management Kit.
 *
 * `@ledgerhq/device-management-kit@1.9.0` cannot be imported as ESM. Its
 * shipped `lib/esm/index.js` is a single line:
 *
 *     export*from"./src";
 *
 * That is a bare directory specifier, which Node's ESM resolver rejects with
 * `ERR_UNSUPPORTED_DIR_IMPORT`, and the package's `exports` map points
 * `import` straight at it. The CJS build is correct, so the package works
 * under `require` and breaks under `import` — the opposite of what a modern
 * consumer expects.
 *
 * The workaround is confined to this file so the rest of the package reads
 * normally, and so removing it later is a one-file change. Types still come
 * from the package's own declarations; only the runtime values are required.
 * Reported upstream in docs/feedback/ledger.md.
 */

import { createRequire } from "node:module";

import { applyLedgerHidFilter } from "./hid-filter.js";
import type {
  DeviceManagementKit,
  DeviceActionState,
} from "@ledgerhq/device-management-kit";
import type { SignerEth } from "@ledgerhq/device-signer-kit-ethereum";

const require = createRequire(import.meta.url);

interface DmkModule {
  DeviceManagementKitBuilder: new () => {
    addTransport(factory: unknown): {
      build(): DeviceManagementKit;
    };
  };
  DeviceActionStatus: {
    NotStarted: "not-started";
    Pending: "pending";
    Stopped: "stopped";
    Completed: "completed";
    Error: "error";
  };
}

interface TransportModule {
  nodeHidTransportFactory: unknown;
}

interface SignerModule {
  SignerEthBuilder: new (args: {
    dmk: DeviceManagementKit;
    sessionId: string;
    originToken?: string;
  }) => { build(): SignerEth };
}

/*
 * Order matters, and the reason is not obvious.
 *
 * The node-hid transport captures its device-listing function into a
 * module-scope object the moment it is required:
 *
 *     const w = { devicesAsync: g.devicesAsync, HIDAsync: g.HIDAsync };
 *
 * Patching `node-hid` afterwards therefore changes nothing — the transport
 * already holds the original reference. The filter has to be installed before
 * the transport module is loaded, which is why this call sits above the
 * require rather than inside connect().
 */
applyLedgerHidFilter();

export const dmkModule = require("@ledgerhq/device-management-kit") as DmkModule;
export const transportModule = require(
  "@ledgerhq/device-transport-kit-node-hid",
) as TransportModule;
export const signerModule = require(
  "@ledgerhq/device-signer-kit-ethereum",
) as SignerModule;

interface LkrpModule {
  LedgerKeyringProtocolBuilder: new (args: {
    dmk: DeviceManagementKit;
    applicationId: number;
    env?: string;
    baseUrl?: string;
  }) => { build(): unknown };
  NobleCryptoService: new () => { createKeyPair(curve: unknown): Promise<unknown> };
  Curve: { K256: unknown };
  LKRPEnv: { PROD: string; STAGING: string };
  Permissions?: { All?: unknown };
}

/**
 * Optional: the Keyring Protocol is only needed when secrets are held in a
 * Key Ring, so a deployment using a file or env source should not fail to
 * start because the package is absent.
 */
export const lkrpModule: LkrpModule | null = (() => {
  try {
    return require(
      "@ledgerhq/device-trusted-app-kit-ledger-keyring-protocol",
    ) as LkrpModule;
  } catch {
    return null;
  }
})();

export const DeviceActionStatus = dmkModule.DeviceActionStatus;

export type { DeviceActionState, DeviceManagementKit, SignerEth };
