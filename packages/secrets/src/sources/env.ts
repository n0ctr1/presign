/**
 * Environment-variable source. Development and CI only.
 *
 * Environment variables leak by design: they are inherited by every child
 * process, show up in crash dumps and process listings, and are routinely
 * captured wholesale by error reporters. This source therefore reports
 * `process` protection so that a deployment requiring hardware protection
 * refuses it rather than silently accepting it.
 */

import type { SecretRef, SecretSource } from "../types.js";

/** `the-graph` + `studio-api-key` -> `THE_GRAPH_STUDIO_API_KEY`. */
export function envVarName(ref: SecretRef): string {
  return `${ref.scope}_${ref.name}`.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

export class EnvSecretSource implements SecretSource {
  readonly name = "env";
  readonly protection = "process" as const;

  readonly #env: Readonly<Record<string, string | undefined>>;

  constructor(env: Readonly<Record<string, string | undefined>> = process.env) {
    this.#env = env;
  }

  get(ref: SecretRef): Promise<string | null> {
    const value = this.#env[envVarName(ref)];
    return Promise.resolve(
      typeof value === "string" && value.length > 0 ? value : null,
    );
  }
}
