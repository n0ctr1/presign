/**
 * The subgraph registry client this service uses.
 *
 * The client itself lives in `@presign/operational-layer`, shared with the
 * demo and the data-layer MCP server; this file only decides how the service
 * launches it. It is an x402 server to its own callers and an MCP client of
 * the registry at the same time.
 */

import {
  REGISTRY_PACKAGE,
  RegistrySubprocess,
  type RegistryToolCaller,
} from "@presign/operational-layer";

export { REGISTRY_PACKAGE };

export interface RegistryClient extends RegistryToolCaller {
  close(): void;
}

export interface RegistryClientOptions {
  /** Executable that speaks the registry's MCP server over stdio. */
  readonly command?: string;
  readonly args?: readonly string[];
}

/**
 * Default to fetching the pinned registry with npx.
 *
 * Right on a developer's machine and wrong in a container, where `npx -y`
 * would reach the network on first use and fail the first verdict rather than
 * the build. An image installs the package and points `REGISTRY_COMMAND` at
 * the binary, so the registry is present before anything asks it a question.
 */
/**
 * Split a command line the way a shell would for the simple cases.
 *
 * Splitting on spaces alone turned a path with a space in it into two
 * arguments, and the registry then failed to start complaining about a file
 * nobody had named.
 */
export function splitArgs(line: string): string[] {
  const args: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let match = pattern.exec(line); match !== null; match = pattern.exec(line)) {
    args.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return args;
}

export function buildRegistryClient(options: RegistryClientOptions = {}): RegistryClient {
  const command = options.command ?? process.env["REGISTRY_COMMAND"] ?? "npx";
  const args =
    options.args ??
    (process.env["REGISTRY_ARGS"] === undefined
      ? ["-y", REGISTRY_PACKAGE]
      : splitArgs(process.env["REGISTRY_ARGS"]));

  return new RegistrySubprocess({ command, args, clientName: "presign-service" });
}
