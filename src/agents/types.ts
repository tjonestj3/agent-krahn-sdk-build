export interface SubagentSpec {
  description: string;
  prompt: string;
  tools: readonly string[];
  model: string;
  maxTurns?: number;
  /**
   * Names of MCP servers (from src/mcp/registry.ts) this subagent is allowed
   * to use. Each name must also appear in the resolved `mcpServers` passed
   * into runAgent — names without a matching server are silently dropped at
   * the runner layer. Per-tool access is still controlled by `tools[]`,
   * which should include the MCP tool names like `mcp__sf-read__soqlQuery`.
   */
  mcpServers?: readonly string[];
}

export interface AgentConfig {
  name: string;
  systemPrompt: string;
  model: string;
  tools: readonly string[];
  maxTurns: number;
  cwd?: string;
  subagents?: Record<string, SubagentSpec>;
}

export interface AgentTelemetry {
  num_turns: number | null;
  duration_ms: number | null;
  total_cost_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
}

export interface AgentResult<T> {
  data: T;
  sessionId: string | null;
  rawText: string;
  telemetry: AgentTelemetry;
}
