/**
 * @presign/mcp-server
 *
 * Exposes the operational layer over MCP: which indexed deployments can serve
 * a risk rule right now, and how stale each one is.
 */

export { buildConfig, type BuildConfigOptions, type ServerConfig } from "./config.js";
export { createServer } from "./server.js";
