export interface SubagentSpec {
  description: string;
  prompt: string;
  tools: readonly string[];
  model: string;
  maxTurns?: number;
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
