/**
 * Where the upstream Ethereum RPC URL comes from.
 *
 * The URL carries an API key, so it is a secret and is resolved the same way
 * every other secret in this project is: from a file outside the repository
 * first, then the environment, then a public fallback. Hard-coding it would put
 * a credential in version control on the first commit that touched simulation.
 *
 * Forking needs **archive** access to historical state. Anvil pins a block and
 * then reads balances, code and storage at that block; once the chain moves
 * past it those become archive requests, and public endpoints refuse them:
 *
 *     debug_traceCall: failed to get account for 0x…:
 *       Archive requests require a personal token
 *
 * Note that the trace itself runs in the local fork, so the provider needs to
 * serve historical *state reads* — not the debug/trace API, which is usually
 * the expensive tier.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Public endpoint. Fine for chain head, refuses archive reads. */
export const PUBLIC_ETHEREUM_RPC = "https://ethereum-rpc.publicnode.com";

export const RPC_SECRET_FILE = "ethereum__rpc-url";

export interface ResolvedRpc {
  readonly url: string;
  /** Where it came from, so a startup line can say so without printing the key. */
  readonly source: "secret-file" | "environment" | "public-fallback";
  /** False for the public fallback, which cannot serve historical state. */
  readonly archiveCapable: boolean;
}

/**
 * Resolve the fork's upstream RPC.
 *
 * @param secretsDir defaults to ~/.presign/secrets
 */
export async function resolveEthereumRpc(
  secretsDir: string = join(homedir(), ".presign", "secrets"),
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<ResolvedRpc> {
  try {
    const fromFile = (await readFile(join(secretsDir, RPC_SECRET_FILE), "utf8")).trim();
    if (fromFile !== "") {
      return { url: fromFile, source: "secret-file", archiveCapable: true };
    }
  } catch {
    // Absent is normal; fall through.
  }

  const fromEnv = env["ETH_RPC_URL"]?.trim();
  if (fromEnv !== undefined && fromEnv !== "") {
    return { url: fromEnv, source: "environment", archiveCapable: true };
  }

  return {
    url: PUBLIC_ETHEREUM_RPC,
    source: "public-fallback",
    archiveCapable: false,
  };
}

/** A URL safe to print: host only, never the key embedded in the path. */
export function describeRpc(resolved: ResolvedRpc): string {
  let host: string;
  try {
    host = new URL(resolved.url).host;
  } catch {
    host = "(unparseable URL)";
  }
  return `${host} via ${resolved.source}${resolved.archiveCapable ? "" : " — NOT archive-capable"}`;
}
