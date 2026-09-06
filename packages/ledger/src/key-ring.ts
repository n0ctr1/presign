/**
 * The Subgraph Studio key, held in a Ledger Key Ring instead of a `.env` file.
 *
 * This is the second Ledger primitive the project uses, and the one that
 * answers "agents that use secrets they cannot leak". The mechanism is the
 * Ledger Keyring Protocol: the device authenticates this client into a
 * trustchain and returns an encryption key, which is then used to encrypt and
 * decrypt secrets locally. Only ciphertext is ever written to disk.
 *
 * ## What this does and does not guarantee
 *
 * Stated precisely, because the tempting summary is stronger than the truth.
 *
 * The Studio key never exists in plaintext on disk, and trustchain membership
 * is revocable from the device — revoke it and the ciphertext becomes
 * undecryptable. Those are real properties, and neither holds for a `.env`
 * file.
 *
 * What it does **not** mean is that no secret is ever in memory. The
 * encryption key is in this process after unlocking, so anything that can read
 * this process can read it. That is why the key is held in memory only and
 * never persisted: an on-disk member key would let anyone with the filesystem
 * reconstruct the encryption key at will, which is `process` protection
 * wearing a hardware label. One device touch per process start is the price of
 * the stronger claim, and it is worth paying.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  SecretProtection,
  SecretRef,
  SecretSource,
} from "@presign/secrets";

import { DeviceActionStatus, lkrpModule } from "./dmk.js";
import type { LedgerDevice } from "./device.js";

/** Ledger's own name for the on-device trusted app this protocol needs. */
export const REQUIRED_DEVICE_APP = "Ledger Sync";

export class KeyRingError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "KeyRingError";
    this.code = code;
  }
}

/** On-disk vault. Ciphertext only; nothing here is usable on its own. */
export interface VaultFile {
  readonly version: 1;
  readonly trustchainId: string;
  readonly applicationPath: string;
  /** `scope/name` to base64 ciphertext. */
  readonly secrets: Readonly<Record<string, string>>;
}

/** The slice of the Keyring Protocol this module uses. */
export interface KeyRingProtocol {
  authenticate(input: {
    keyPair: unknown;
    clientName: string;
    permissions: unknown;
    sessionId?: string;
    trustchainId?: string;
  }): {
    observable: {
      subscribe(handlers: {
        next: (state: Record<string, unknown>) => void;
        error: (error: unknown) => void;
      }): { unsubscribe(): void };
    };
    cancel(): void;
  };
  encryptData(key: Uint8Array, data: Uint8Array): Promise<Uint8Array>;
  decryptData(key: Uint8Array, data: Uint8Array): Promise<Uint8Array>;
}

export interface AuthenticatedSession {
  readonly trustchainId: string;
  readonly applicationPath: string;
  readonly encryptionKey: Uint8Array;
}

const vaultKey = (ref: SecretRef) => `${ref.scope}/${ref.name}`;

/**
 * Run the authenticate device action to completion.
 *
 * Errors are translated rather than passed through: `6807` in particular is
 * the device saying the trusted app is absent, and the raw message ("Unknown
 * application name") reads like a bad name string rather than a missing
 * install — a distinction that cost real time to discover.
 */
export function runAuthenticate(
  protocol: KeyRingProtocol,
  input: {
    keyPair: unknown;
    clientName: string;
    permissions: unknown;
    sessionId?: string;
    trustchainId?: string;
  },
  options: { timeoutMs?: number; onStep?: (step: string) => void } = {},
): Promise<AuthenticatedSession> {
  const timeoutMs = options.timeoutMs ?? 120_000;

  return new Promise<AuthenticatedSession>((resolve, reject) => {
    let settled = false;
    const action = protocol.authenticate(input);

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      subscription.unsubscribe();
      fn();
    };

    const timer = setTimeout(() => {
      action.cancel();
      finish(() =>
        reject(new KeyRingError("timeout", `no response within ${timeoutMs}ms`)),
      );
    }, timeoutMs);

    const subscription = action.observable.subscribe({
      next: (state) => {
        const status = state["status"];

        if (status === DeviceActionStatus.Pending) {
          const step = (state["intermediateValue"] as { step?: string } | undefined)?.step;
          if (step !== undefined) options.onStep?.(step);
          return;
        }

        if (status === DeviceActionStatus.Completed) {
          finish(() => resolve(state["output"] as AuthenticatedSession));
          return;
        }

        if (status === DeviceActionStatus.Stopped) {
          finish(() =>
            reject(new KeyRingError("cancelled", "the device action stopped")),
          );
          return;
        }

        if (status === DeviceActionStatus.Error) {
          const error = state["error"] as {
            errorCode?: string;
            message?: string;
            _tag?: string;
          };
          finish(() => reject(translateError(error)));
        }
      },
      error: (error) =>
        finish(() =>
          reject(
            new KeyRingError(
              "device_error",
              error instanceof Error ? error.message : String(error),
            ),
          ),
        ),
    });
  });
}

function translateError(error: {
  errorCode?: string;
  message?: string;
  _tag?: string;
}): KeyRingError {
  /*
   * Three device-side states, each needing a different action from a human,
   * and only the third is a fault. Collapsing them into "device error" would
   * send an operator to the wrong place every time.
   */
  if (error.message?.includes("must be initialized from Ledger Live") === true) {
    return new KeyRingError(
      "trustchain_not_initialized",
      `the "${REQUIRED_DEVICE_APP}" app is installed but no trustchain exists for ` +
        "this device. Initialise Ledger Sync in Ledger Live with this device " +
        "connected, which creates the trustchain, then retry. Installing the app " +
        "alone is not sufficient.",
    );
  }
  if (error.errorCode === "6807") {
    return new KeyRingError(
      "device_app_missing",
      `the "${REQUIRED_DEVICE_APP}" app is not installed on this device. ` +
        "Install it by enabling Ledger Sync in Ledger Live, then retry.",
    );
  }
  if (error._tag === "DeviceLockedError") {
    return new KeyRingError(
      "device_locked",
      "the device is locked; unlock it with its PIN and retry",
    );
  }
  return new KeyRingError(
    "device_error",
    error.message ?? error._tag ?? "unknown keyring protocol error",
  );
}

export interface UnlockOptions {
  readonly device: LedgerDevice;
  readonly vaultPath: string;
  /** Trustchain application id. Separates this app's keys from others'. */
  readonly applicationId?: number;
  readonly clientName?: string;
  /** Injected in tests; defaults to the real protocol built on the device. */
  readonly protocol?: KeyRingProtocol;
  readonly onStep?: (step: string) => void;
}

/**
 * A `SecretSource` backed by the Ledger Key Ring.
 *
 * Reports `hardware` protection, which is only honest because the encryption
 * key is obtained from the device at unlock and never written down. See the
 * module comment.
 */
export class LedgerKeyRingSecretSource implements SecretSource {
  readonly name = "ledger-key-ring";
  readonly protection: SecretProtection = "hardware";

  readonly #protocol: KeyRingProtocol;
  readonly #session: AuthenticatedSession;
  readonly #vaultPath: string;
  #vault: VaultFile;

  private constructor(
    protocol: KeyRingProtocol,
    session: AuthenticatedSession,
    vaultPath: string,
    vault: VaultFile,
  ) {
    this.#protocol = protocol;
    this.#session = session;
    this.#vaultPath = vaultPath;
    this.#vault = vault;
  }

  /** One device touch. The encryption key stays in memory from here on. */
  static async unlock(options: UnlockOptions): Promise<LedgerKeyRingSecretSource> {
    const protocol =
      options.protocol ??
      (lkrpModule === null
        ? (() => {
            throw new KeyRingError(
              "protocol_unavailable",
              "the Ledger Keyring Protocol package is not installed",
            );
          })()
        : (new lkrpModule.LedgerKeyringProtocolBuilder({
            dmk: options.device.kit,
            applicationId: options.applicationId ?? 16,
            env: lkrpModule.LKRPEnv.PROD,
          }).build() as unknown as KeyRingProtocol));

    const crypto = new lkrpModule!.NobleCryptoService();
    const keyPair = await crypto.createKeyPair(lkrpModule!.Curve.K256);

    const existing = await readVault(options.vaultPath);

    const session = await runAuthenticate(
      protocol,
      {
        keyPair,
        clientName: options.clientName ?? "presign",
        permissions: lkrpModule!.Permissions?.All ?? 0xffffffff,
        // Re-authenticating into an existing trustchain when we have one keeps
        // previously stored ciphertext readable.
        ...(existing === null
          ? { sessionId: options.device.sessionId }
          : { trustchainId: existing.trustchainId, sessionId: options.device.sessionId }),
      },
      options.onStep === undefined ? {} : { onStep: options.onStep },
    );

    const vault: VaultFile = existing ?? {
      version: 1,
      trustchainId: session.trustchainId,
      applicationPath: session.applicationPath,
      secrets: {},
    };

    return new LedgerKeyRingSecretSource(
      protocol,
      session,
      options.vaultPath,
      vault,
    );
  }

  /** For tests and for callers that already hold a session. */
  static fromSession(
    protocol: KeyRingProtocol,
    session: AuthenticatedSession,
    vaultPath: string,
    vault: VaultFile,
  ): LedgerKeyRingSecretSource {
    return new LedgerKeyRingSecretSource(protocol, session, vaultPath, vault);
  }

  get trustchainId(): string {
    return this.#session.trustchainId;
  }

  async get(ref: SecretRef): Promise<string | null> {
    const ciphertext = this.#vault.secrets[vaultKey(ref)];
    if (ciphertext === undefined) return null;

    const plaintext = await this.#protocol.decryptData(
      this.#session.encryptionKey,
      Buffer.from(ciphertext, "base64"),
    );
    return Buffer.from(plaintext).toString("utf8");
  }

  /** Encrypt and persist. Only ciphertext reaches the disk. */
  async store(ref: SecretRef, value: string): Promise<void> {
    const ciphertext = await this.#protocol.encryptData(
      this.#session.encryptionKey,
      Buffer.from(value, "utf8"),
    );

    this.#vault = {
      ...this.#vault,
      secrets: {
        ...this.#vault.secrets,
        [vaultKey(ref)]: Buffer.from(ciphertext).toString("base64"),
      },
    };

    await mkdir(dirname(this.#vaultPath), { recursive: true });
    await writeFile(this.#vaultPath, JSON.stringify(this.#vault, null, 2), {
      mode: 0o600,
    });
  }
}

async function readVault(path: string): Promise<VaultFile | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as VaultFile;
    if (parsed.version !== 1 || typeof parsed.trustchainId !== "string") {
      throw new KeyRingError("vault_corrupt", `${path} is not a valid vault`);
    }
    return parsed;
  } catch (error) {
    if (error instanceof KeyRingError) throw error;
    return null;
  }
}
