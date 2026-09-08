#!/usr/bin/env node
/** stdio entry point: `npx presign-mcp`. */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { buildConfig } from "./config.js";
import { createServer } from "./server.js";

const config = await buildConfig();
const server = createServer(config);

// stdout is the transport. Anything written there that is not a JSON-RPC frame
// corrupts the stream, so diagnostics go to stderr.
process.on("SIGINT", () => {
  config.close();
  process.exit(0);
});
process.on("SIGTERM", () => {
  config.close();
  process.exit(0);
});

await server.connect(new StdioServerTransport());
process.stderr.write("presign MCP server ready on stdio\n");
