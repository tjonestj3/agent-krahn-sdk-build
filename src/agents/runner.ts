import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  ROUTER_ALLOWED_TOOLS,
  ROUTER_MAX_TURNS,
  ROUTER_MODEL,
  buildRouterSystemPrompt,
} from './router-agent.js';
import { env } from '../config/env.js';

export interface RouterResult {
  client: string | null;
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
  recommended_dev_hub: string | null;
  options: Array<{ alias: string; use_when: string }>;
  session_id: string | null;
}

export async function runRouter(rawRequest: string): Promise<RouterResult> {
  const systemPrompt = buildRouterSystemPrompt(env.VAULT_PATH);

  const response = query({
    prompt: `Triage this client request:\n\n${rawRequest}`,
    options: {
      systemPrompt,
      tools: [...ROUTER_ALLOWED_TOOLS],
      allowedTools: [...ROUTER_ALLOWED_TOOLS],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      maxTurns: ROUTER_MAX_TURNS,
      model: ROUTER_MODEL,
      cwd: env.VAULT_PATH,
    },
  });

  const transcript: string[] = [];
  let sessionId: string | null = null;

  for await (const msg of response) {
    if (msg.session_id) sessionId = msg.session_id;

    if (msg.type === 'assistant') {
      for (const block of msg.message.content) {
        if (block.type === 'text') transcript.push(block.text);
      }
    }
  }

  const fullText = transcript.join('\n');
  const parsed = extractFinalJson(fullText);

  if (!parsed) {
    throw new Error(
      `Router did not emit a parseable JSON block. Last assistant text:\n${fullText.slice(-500)}`,
    );
  }

  return { ...parsed, session_id: sessionId };
}

function extractFinalJson(text: string): Omit<RouterResult, 'session_id'> | null {
  const fenced = [...text.matchAll(/```json\s*([\s\S]*?)\s*```/g)];
  const candidate = fenced.length > 0 ? fenced[fenced.length - 1]?.[1] : text.trim();
  if (!candidate) return null;

  try {
    return JSON.parse(candidate) as Omit<RouterResult, 'session_id'>;
  } catch {
    return null;
  }
}
