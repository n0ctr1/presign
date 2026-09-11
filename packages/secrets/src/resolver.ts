/**
 * Resolves a secret through an ordered chain of sources and reports which one
 * answered.
 */

import {
  InsufficientProtectionError,
  SecretNotFoundError,
  type ResolvedSecret,
  type SecretProtection,
  type SecretRef,
  type SecretSource,
} from "./types.js";

const PROTECTION_RANK: Readonly<Record<SecretProtection, number>> = {
  process: 0,
  "hardware-rooted": 1,
  hardware: 2,
};

export interface SecretResolverOptions {
  /**
   * Reject any secret resolved from a source weaker than this.
   *
   * Production sets `hardware`, which is what makes the guarantee real rather
   * than aspirational: with it set, a misconfigured deployment that would have
   * quietly fallen back to an environment variable fails at startup instead.
   */
  readonly minimumProtection?: SecretProtection;
}

export class SecretResolver {
  readonly #sources: readonly SecretSource[];
  readonly #minimumProtection: SecretProtection;

  constructor(
    sources: readonly SecretSource[],
    options: SecretResolverOptions = {},
  ) {
    this.#sources = sources;
    this.#minimumProtection = options.minimumProtection ?? "process";
  }

  /**
   * First source that holds the secret wins, so order the chain
   * strongest-first: a hardware source ahead of a file keeps a leftover
   * development file from shadowing the device.
   */
  async resolve(ref: SecretRef): Promise<ResolvedSecret> {
    const tried: string[] = [];

    for (const source of this.#sources) {
      tried.push(source.name);
      const value = await source.get(ref);
      if (value === null) continue;

      if (
        PROTECTION_RANK[source.protection] <
        PROTECTION_RANK[this.#minimumProtection]
      ) {
        throw new InsufficientProtectionError(
          ref,
          source.protection,
          this.#minimumProtection,
        );
      }

      return {
        ref,
        value,
        source: source.name,
        protection: source.protection,
        resolvedAt: new Date(),
      };
    }

    throw new SecretNotFoundError(ref, tried);
  }
}
