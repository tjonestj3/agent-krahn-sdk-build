// Named MCP server registry. Agents and orchestrator code refer to MCP servers
// by name (e.g. 'sf-read'); this file is the single place that knows how to
// actually spawn each one. Keep it boring — adding a server is a one-line
// addition here plus a corresponding entry in vault `_index.md` per client
// that should have access.
//
// The Anthropic Agent SDK can take per-subagent MCP server names as strings
// when those names appear in the top-level `mcpServers` map. We pass the
// resolved subset (per-client) to runAgent, which spreads it into the SDK
// options and references the names from each subagent's AgentDefinition.

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { loadClientConfig } from '../config/clients.js';

const HERE = dirname(fileURLToPath(import.meta.url));

export const MCP_SERVER_REGISTRY: Record<string, McpServerConfig> = {
  // Read-only Salesforce. Wraps bin/{prod,scratch}-{query,describe}.sh.
  // Tools: soqlQuery, describeSObject. Both accept optional `alias` —
  // omit for the project default target-org (scratch in pipeline context),
  // pass the client's prod alias for prod reads.
  'sf-read': {
    type: 'stdio',
    command: 'npx',
    args: ['tsx', resolve(HERE, 'sf-read-mcp.ts')],
  },
};

export type McpServerName = keyof typeof MCP_SERVER_REGISTRY;

/**
 * Look up a list of named MCP servers in the registry. Unknown names are
 * skipped with a stderr warning rather than thrown — a vault entry for a
 * server that isn't (yet) registered should degrade gracefully, not crash
 * a pipeline.
 */
export function resolveMcpServers(
  names: readonly string[],
): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const name of names) {
    const config = MCP_SERVER_REGISTRY[name];
    if (!config) {
      console.warn(`[mcp/registry] unknown MCP server: ${name} (skipping)`);
      continue;
    }
    out[name] = config;
  }
  return out;
}

/**
 * Load a client's MCP server allowlist from vault and resolve each entry
 * against the registry. Returns an empty map if the client name is missing
 * or the vault read fails. Used by the orchestrator and resume paths to
 * decide which servers to spin up for a given pipeline.
 */
export async function resolveClientMcpServers(
  clientName: string | null | undefined,
): Promise<Record<string, McpServerConfig>> {
  if (!clientName) return {};
  try {
    const config = await loadClientConfig(clientName);
    return resolveMcpServers(config.mcp_servers);
  } catch (err) {
    console.warn(
      `[mcp/registry] could not resolve MCP servers for client "${clientName}":`,
      err,
    );
    return {};
  }
}
