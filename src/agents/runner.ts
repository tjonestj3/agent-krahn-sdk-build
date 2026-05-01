import { query } from '@anthropic-ai/claude-agent-sdk';
import type { AgentConfig, AgentResult } from './types.js';
import {
  ROUTER_CONFIG,
  type RouterPayload,
  buildRouterUserPrompt,
  gatherRouterContext,
} from './router-agent.js';
import {
  TRIAGE_CONFIG,
  type TriagePayload,
  buildTriageResumePrompt,
} from './triage-agent.js';
import {
  WORK_IDENTIFIER_CONFIG,
  type WorkIdentifierPayload,
  buildWorkIdentifierUserPrompt,
  buildWorkIdentifierResumePrompt,
} from './work-identifier-agent.js';

export interface RunOptions {
  resume?: string;
}

export async function runAgent<T>(
  config: AgentConfig,
  userPrompt: string,
  runOptions?: RunOptions,
): Promise<AgentResult<T>> {
  const response = query({
    prompt: userPrompt,
    options: {
      systemPrompt: config.systemPrompt,
      tools: [...config.tools],
      allowedTools: [...config.tools],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      maxTurns: config.maxTurns,
      model: config.model,
      ...(config.cwd ? { cwd: config.cwd } : {}),
      ...(runOptions?.resume ? { resume: runOptions.resume } : {}),
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

  const rawText = transcript.join('\n');
  const data = extractFinalJson<T>(rawText);

  if (!data) {
    throw new Error(
      `[${config.name}] did not emit a parseable JSON block. Last assistant text:\n${rawText.slice(-500)}`,
    );
  }

  return { data, sessionId, rawText };
}

function extractFinalJson<T>(text: string): T | null {
  const fenced = [...text.matchAll(/```json\s*([\s\S]*?)\s*```/g)];
  const candidate = fenced.length > 0 ? fenced[fenced.length - 1]?.[1] : text.trim();
  if (!candidate) return null;

  try {
    return JSON.parse(candidate) as T;
  } catch {
    return null;
  }
}

export async function runTriage(rawRequest: string): Promise<AgentResult<TriagePayload>> {
  return runAgent<TriagePayload>(TRIAGE_CONFIG, rawRequest);
}

export async function resumeTriage(
  sessionId: string,
  answer: string,
): Promise<AgentResult<TriagePayload>> {
  return runAgent<TriagePayload>(TRIAGE_CONFIG, buildTriageResumePrompt(answer), {
    resume: sessionId,
  });
}

export async function runRouter(
  rawRequest: string,
  triage?: TriagePayload,
): Promise<AgentResult<RouterPayload>> {
  const context = await gatherRouterContext();
  return runAgent<RouterPayload>(
    ROUTER_CONFIG,
    buildRouterUserPrompt(rawRequest, context, triage),
  );
}

export async function runWorkIdentifier(
  rawRequest: string,
  triage: TriagePayload,
  routed: RouterPayload,
): Promise<AgentResult<WorkIdentifierPayload>> {
  return runAgent<WorkIdentifierPayload>(
    WORK_IDENTIFIER_CONFIG,
    buildWorkIdentifierUserPrompt(rawRequest, triage, routed),
  );
}

export async function resumeWorkIdentifier(
  sessionId: string,
  answer: string,
): Promise<AgentResult<WorkIdentifierPayload>> {
  return runAgent<WorkIdentifierPayload>(
    WORK_IDENTIFIER_CONFIG,
    buildWorkIdentifierResumePrompt(answer),
    { resume: sessionId },
  );
}
