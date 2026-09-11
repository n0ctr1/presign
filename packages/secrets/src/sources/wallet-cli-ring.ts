/**
 * Secrets sealed with the Ledger Key Ring, read through `wallet-cli ring`.
 *
 * The file holds ciphertext written by `wallet-cli ring encrypt`; this source
 * hands it to `wallet-cli ring decrypt` and returns what comes back. Nothing
 * here implements cryptography or talks to a device: the Key Ring CLI does
 * both, and a second implementation of either would be one more thing to trust.
 *
 * ## What it protects, stated precisely
 *
 * The secret at rest is AES-256-GCM ciphertext under a key derived from the
 * Ledger Key Ring. Decrypting needs this machine's Key Ring membership — a
 * member credential `ring init` put in the OS keychain, password-wrapped
 * unless the ring was created without one — and network access to restore the
 * trustchain. It does not need the device per use; that is what lets an agent
 * run unattended. So the file alone is useless, a copied file on another
 * machine is useless, and removing this member from the ring ends every
 * future decryption.
 *
 * What it does not do is keep the plaintext out of this process once read. An
 * agent still holds its payment key in memory to sign with. The point is the
 * boundary around it: the key is never in a file, never in the model's
 * context, and never in a place a transcript or a backup would capture.
 *
 * ## Failures do not fall through
 *
 * When a ciphertext file exists and cannot be decrypted, this throws rather
 * than returning null. Null would let the resolver move on to a plaintext file
 * or an environment variable, which turns "the Key Ring refused" into "used
 * the unprotected copy" — the downgrade this source exists to remove.
 */

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";

import type { SecretRef, SecretSource } from "../types.js";

export class WalletCliRingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalletCliRingError";
  }
}

/** `hedera` + `testnet-agent-key` -> `presign:hedera:testnet-agent-key`. */
export function ringKeyName(ref: SecretRef): string {
  return `presign:${ref.scope}:${ref.name}`;
}

/** `hedera` + `testnet-agent-key` -> `hedera__testnet-agent-key.enc`. */
export function ringFileName(ref: SecretRef): string {
  return `${ref.scope}__${ref.name}.enc`;
}

export interface WalletCliRingSourceOptions {
  /** Directory holding `scope__name.enc` files. */
  readonly directory: string;
  /** Defaults to `WALLET_CLI_BIN`, then `wallet-cli` on the PATH. */
  readonly binary?: string;
  /**
   * Restoring the trustchain is several HTTP round trips, so this is generous.
   * It also bounds the case where a password-protected ring has no
   * `WALLET_PASS` to read and would otherwise wait for input forever.
   */
  readonly timeoutMs?: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** Pull the CLI's own message out of its JSON error, if it wrote one. */
function cliMessage(stderr: string): string {
  const trimmed = stderr.trim();
  try {
    const parsed = JSON.parse(trimmed) as { error?: { message?: string } };
    if (typeof parsed.error?.message === "string") return parsed.error.message;
  } catch {
    // Human output rather than JSON; the text is the message.
  }
  return trimmed === "" ? "no error output" : trimmed.split("\n").slice(-3).join(" ");
}

export class WalletCliRingSource implements SecretSource {
  readonly name = "ledger-key-ring (wallet-cli ring)";
  readonly protection = "hardware-rooted" as const;

  readonly #directory: string;
  readonly #binary: string;
  readonly #timeoutMs: number;
  readonly #env: Readonly<Record<string, string | undefined>>;

  constructor(options: WalletCliRingSourceOptions) {
    this.#directory = options.directory;
    this.#env = options.env ?? process.env;
    this.#binary = options.binary ?? this.#env["WALLET_CLI_BIN"] ?? "wallet-cli";
    this.#timeoutMs = options.timeoutMs ?? 60_000;
  }

  async get(ref: SecretRef): Promise<string | null> {
    const file = join(this.#directory, ringFileName(ref));
    try {
      await access(file);
    } catch {
      // No ciphertext for this secret: not ours to answer.
      return null;
    }

    const plaintext = await this.#decrypt(ringKeyName(ref), file);
    const value = plaintext.trim();
    if (value === "") {
      throw new WalletCliRingError(`wallet-cli ring decrypted ${file} to an empty value`);
    }
    return value;
  }

  #decrypt(key: string, file: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        this.#binary,
        ["ring", "decrypt", "--key", key, "--input", file],
        {
          // stdin closed: with no terminal the CLI reads WALLET_PASS from the
          // environment, and nothing here should ever type a password.
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...this.#env, WALLET_CLI_NO_NUDGE: "1" },
        },
      );

      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => err.push(chunk));

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(
          new WalletCliRingError(
            `wallet-cli ring decrypt did not finish within ${this.#timeoutMs} ms. ` +
              "A password-protected ring reads WALLET_PASS from this process's " +
              "environment; inject it from the OS keychain rather than typing it.",
          ),
        );
      }, this.#timeoutMs);

      child.on("error", (error) => {
        clearTimeout(timer);
        reject(
          new WalletCliRingError(
            `could not run ${this.#binary}: ${error.message}. ` +
              "Install it with `npm i -g @ledgerhq/wallet-cli` or set WALLET_CLI_BIN.",
          ),
        );
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve(Buffer.concat(out).toString("utf8"));
          return;
        }
        reject(
          new WalletCliRingError(
            `wallet-cli ring decrypt refused ${file}: ${cliMessage(Buffer.concat(err).toString("utf8"))}`,
          ),
        );
      });
    });
  }
}
