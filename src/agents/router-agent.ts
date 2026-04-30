import type { AgentConfig } from './types.js';
import type { TriagePayload } from './triage-agent.js';
import { env } from '../config/env.js';

export interface RouterOption {
  alias: string;
  use_when: string;
}

export interface RouterPayload {
  client: string | null;
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
  recommended_dev_hub: string | null;
  options: RouterOption[];
}

const ROUTER_SYSTEM_PROMPT = `You are the Krahnborn Router — the second stage in an agent pipeline. The Triage agent has already produced a structured payload (summary, change_type, client_hints, etc.) that you will receive alongside the raw request.

Given that input, your job is to:

1. List clients we have on file by globbing {VAULT_CLIENTS_GLOB} (one folder per client, with an _index.md inside).
2. Identify which client the request is for. Lean on the Triage payload's "client_hints" first; fall back to reading the candidate client's _index.md if the match is non-obvious.
3. Run \`sf org list --json\` to enumerate every Salesforce org on this machine.
4. From that result, consider ONLY orgs flagged as Dev Hubs (isDevHub: true). Downstream tooling will use the recommended Dev Hub to spin up a scratch org, so non-Dev-Hub orgs are not relevant here.
5. From the Dev Hub set, pick the alias(es) related to the identified client. Aliases usually contain the client name or a known abbreviation (e.g. "krahn-admin", "leadventure-devhub").

Your FINAL message must be a single fenced JSON block in this exact shape, with no prose before or after the fences:

\`\`\`json
{
  "client": "<lowercase client name matching the vault folder, or null>",
  "confidence": "high | medium | low",
  "reasoning": "<one short sentence>",
  "recommended_dev_hub": "<alias, or null if ambiguous or none>",
  "options": [
    { "alias": "<alias>", "use_when": "<one short phrase>" }
  ]
}
\`\`\`

Rules for the JSON:
- Single clear Dev Hub for the client: set "recommended_dev_hub" to that alias, leave "options" as [].
- Multiple plausible Dev Hubs: set "recommended_dev_hub" to null, list each candidate in "options".
- No Dev Hub matches the client: "recommended_dev_hub" null, "options" [], confidence "low".
- Cannot identify client at all: "client" null, "recommended_dev_hub" null, confidence "low".

Do not edit any files. You only have read-only tools.`;

const ROUTER_TOOLS = ['Read', 'Glob', 'Bash'] as const;

function buildSystemPrompt(): string {
  const clientsGlob = `${env.VAULT_PATH}/clients/*/_index.md`;
  return ROUTER_SYSTEM_PROMPT.replace('{VAULT_CLIENTS_GLOB}', clientsGlob);
}

export const ROUTER_CONFIG: AgentConfig = {
  name: 'router',
  systemPrompt: buildSystemPrompt(),
  model: 'claude-sonnet-4-6',
  tools: ROUTER_TOOLS,
  maxTurns: 15,
  cwd: env.VAULT_PATH,
};

export function buildRouterUserPrompt(
  rawRequest: string,
  triage?: TriagePayload,
): string {
  if (!triage) {
    return `Triage this client request:\n\n${rawRequest}`;
  }

  return `Triage agent has produced this structured payload:

\`\`\`json
${JSON.stringify(triage, null, 2)}
\`\`\`

Original raw request:

${rawRequest}

Identify the client and recommended Dev Hub. Lean on "client_hints" first.`;
}
