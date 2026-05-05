import { query } from '@anthropic-ai/claude-agent-sdk';
import type { AgentConfig, AgentResult, AgentTelemetry } from './types.js';
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
import { loadClientConfig } from '../config/clients.js';
import {
  EXECUTION_CONFIG,
  type ExecutionPayload,
  buildExecutionUserPrompt,
  buildExecutionResumePrompt,
} from './execution-agent.js';
import {
  DOCUMENTATION_CONFIG,
  type DocumentationPayload,
  type DocumentationContext,
  buildDocumentationUserPrompt,
} from './documentation-agent.js';
import type { ExecutionContext } from '../execution/setup.js';
import type { PipelineRow } from '../db/pipelines.js';
import type { TriagePayload as Triage } from './triage-agent.js';
import type { RouterPayload as Routed } from './router-agent.js';
import type { WorkIdentifierPayload as Wi } from './work-identifier-agent.js';

export interface RunOptions {
  resume?: string;
}

export async function runAgent<T>(
  config: AgentConfig,
  userPrompt: string,
  runOptions?: RunOptions,
): Promise<AgentResult<T>> {
  // If the agent declares subagents, give the parent the `Agent` tool so it
  // can dispatch via Task — and pass each spec through as an AgentDefinition.
  // Subagent specs are converted to the shape the SDK expects; no MCPs and
  // no settings inheritance, same as the parent.
  const hasSubagents =
    config.subagents !== undefined && Object.keys(config.subagents).length > 0;
  const tools = hasSubagents ? [...config.tools, 'Agent'] : [...config.tools];
  const agents = hasSubagents
    ? Object.fromEntries(
        Object.entries(config.subagents!).map(([name, spec]) => [
          name,
          {
            description: spec.description,
            prompt: spec.prompt,
            tools: [...spec.tools],
            model: spec.model,
            ...(spec.maxTurns !== undefined ? { maxTurns: spec.maxTurns } : {}),
          },
        ]),
      )
    : undefined;

  const response = query({
    prompt: userPrompt,
    options: {
      systemPrompt: config.systemPrompt,
      tools,
      allowedTools: tools,
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: [],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      maxTurns: config.maxTurns,
      model: config.model,
      ...(agents ? { agents } : {}),
      ...(config.cwd ? { cwd: config.cwd } : {}),
      ...(runOptions?.resume ? { resume: runOptions.resume } : {}),
    },
  });

  const transcript: string[] = [];
  let sessionId: string | null = null;
  let telemetry: AgentTelemetry = {
    num_turns: null,
    duration_ms: null,
    total_cost_usd: null,
    input_tokens: null,
    output_tokens: null,
    cache_read_input_tokens: null,
    cache_creation_input_tokens: null,
  };

  for await (const msg of response) {
    const m = msg as Record<string, unknown>;
    if (typeof m.session_id === 'string') sessionId = m.session_id;

    if (m.type === 'assistant') {
      const inner = (m as { message?: { content?: unknown[] } }).message;
      const content = Array.isArray(inner?.content) ? inner.content : [];
      for (const block of content) {
        const b = block as { type?: string; text?: string };
        if (b.type === 'text' && typeof b.text === 'string') {
          transcript.push(b.text);
        }
      }
    }

    if (m.type === 'result') {
      telemetry = extractTelemetry(m);
    }
  }

  const rawText = transcript.join('\n');
  const data = extractFinalJson<T>(rawText);

  if (!data) {
    throw new Error(
      `[${config.name}] did not emit a parseable JSON block. Last assistant text:\n${rawText.slice(-500)}`,
    );
  }

  return { data, sessionId, rawText, telemetry };
}

function extractTelemetry(msg: Record<string, unknown>): AgentTelemetry {
  const usage = (msg.usage ?? {}) as Record<string, unknown>;
  return {
    num_turns: numOrNull(msg.num_turns),
    duration_ms: numOrNull(msg.duration_ms),
    total_cost_usd: numOrNull(msg.total_cost_usd),
    input_tokens: numOrNull(usage.input_tokens),
    output_tokens: numOrNull(usage.output_tokens),
    cache_read_input_tokens: numOrNull(usage.cache_read_input_tokens),
    cache_creation_input_tokens: numOrNull(usage.cache_creation_input_tokens),
  };
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
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
  const permissionSets = routed.client
    ? await loadClientConfig(routed.client)
        .then((c) => c.permission_sets)
        .catch(() => [])
    : [];
  return runAgent<WorkIdentifierPayload>(
    WORK_IDENTIFIER_CONFIG,
    buildWorkIdentifierUserPrompt(rawRequest, triage, routed, permissionSets),
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

export async function runExecution(
  rawRequest: string,
  triage: TriagePayload,
  routed: RouterPayload,
  workIdentifier: WorkIdentifierPayload,
  ctx: ExecutionContext,
): Promise<AgentResult<ExecutionPayload>> {
  return runAgent<ExecutionPayload>(
    { ...EXECUTION_CONFIG, cwd: ctx.repo_local },
    buildExecutionUserPrompt(rawRequest, triage, routed, workIdentifier, ctx),
  );
}

export async function resumeExecution(
  sessionId: string,
  answer: string,
  ctx: ExecutionContext,
): Promise<AgentResult<ExecutionPayload>> {
  return runAgent<ExecutionPayload>(
    { ...EXECUTION_CONFIG, cwd: ctx.repo_local },
    buildExecutionResumePrompt(answer),
    { resume: sessionId },
  );
}

export async function runDocumentation(
  pipeline: PipelineRow,
  triage: Triage,
  routed: Routed,
  wi: Wi,
  exec: ExecutionPayload,
  ctx: DocumentationContext,
): Promise<AgentResult<DocumentationPayload>> {
  return runAgent<DocumentationPayload>(
    { ...DOCUMENTATION_CONFIG, cwd: ctx.repo_local },
    buildDocumentationUserPrompt(pipeline, triage, routed, wi, exec, ctx),
  );
}
