export interface AgentConfig {
  name: string;
  systemPrompt: string;
  model: string;
  tools: readonly string[];
  maxTurns: number;
  cwd?: string;
}

export interface AgentResult<T> {
  data: T;
  sessionId: string | null;
  rawText: string;
}
