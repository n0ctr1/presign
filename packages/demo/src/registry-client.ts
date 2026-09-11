/**
 * The subgraph registry for the demo harnesses.
 *
 * Extracted from the wiring because the coverage sweep needs a registry
 * without needing a fork, an anvil or a verdict engine — and building one just
 * to ask which deployments conform would take a minute to start and cost an
 * archive RPC for nothing. The client is the shared one from
 * `@presign/operational-layer`, launched with the pinned package.
 */

import { RegistrySubprocess } from "@presign/operational-layer";

export function buildRegistry(): RegistrySubprocess {
  return new RegistrySubprocess({ clientName: "presign-demo" });
}
