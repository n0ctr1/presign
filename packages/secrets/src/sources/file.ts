/**
 * File-backed source, for a developer machine with no attached device.
 *
 * Refuses to read a file that is group- or world-readable. A credential file
 * with permissive modes is the single most common way a key ends up somewhere
 * it was never meant to be, and failing loudly at startup costs less than
 * discovering it later.
 */

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import type { SecretRef, SecretSource } from "../types.js";

/** Raised when a secret file is readable by anyone other than its owner. */
export class InsecureFilePermissionsError extends Error {
  constructor(path: string, mode: number) {
    super(
      `${path} is mode ${mode.toString(8).padStart(4, "0")}; secret files must not be group- or world-readable (chmod 600)`,
    );
    this.name = "InsecureFilePermissionsError";
  }
}

export class FileSecretSource implements SecretSource {
  readonly name = "file";
  readonly protection = "process" as const;

  readonly #directory: string;

  /** @param directory holds one file per secret, named `<scope>__<name>`. */
  constructor(directory: string) {
    this.#directory = directory;
  }

  async get(ref: SecretRef): Promise<string | null> {
    const path = join(this.#directory, `${ref.scope}__${ref.name}`);

    let mode: number;
    try {
      mode = (await stat(path)).mode & 0o777;
    } catch {
      // Absent is not an error: the resolver moves on to the next source.
      return null;
    }

    if ((mode & 0o077) !== 0) {
      throw new InsecureFilePermissionsError(path, mode);
    }

    // Trailing newlines are what a shell redirect leaves behind, and a key with
    // a stray "\n" fails authentication in a way that reads like a bad key.
    const value = (await readFile(path, "utf8")).trim();
    return value.length > 0 ? value : null;
  }
}
