import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentConfig } from './types.js';
import type { TriagePayload } from './triage-agent.js';
import { env } from '../config/env.js';

const execFileAsync = promisify(execFile);

const SF_ORGS_SUMMARY_SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../bin/sf-orgs-summary.sh',
);

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

export interface OrgSummary {
  alias: string | null;
  username: string | null;
  orgId: string | null;
  isDevHub: boolean;
  connectedStatus: string | null;
  isDefaultDevHub: boolean;
  lastUsed: string | null;
}

export interface ClientEntry {
  name: string;
  index: string;
}

export interface RouterContext {
  clients: ClientEntry[];
  devHubs: OrgSummary[];
}

const ROUTER_SYSTEM_PROMPT = `You are the Krahnborn Router — the second stage in an agent pipeline. The Triage agent has already produced a structured payload (summary, change_type, client_hints, etc.). You will also receive a pre-gathered context object containing the vault's known clients and the Dev Hub orgs available on this machine.

You have NO tools. All evidence is in the user message. Inspect it and emit a single JSON decision.

## What's in your evidence

- **clients**: every folder under \`vault/clients/<name>/\` and the contents of its \`_index.md\` (industry, contacts, common request types, etc.).
- **devHubs**: every Salesforce org on this machine with \`isDevHub: true\`, trimmed to {alias, username, orgId, connectedStatus, isDefaultDevHub, lastUsed}. Non-Dev-Hub orgs have already been filtered out.
- **triage**: the Triage agent's structured output, especially \`client_hints\`.
- **raw_request**: the original ask, in case the wording matters.

## What you cannot know

You cannot query inside any Salesforce org. You cannot look up users, contacts, cases, or records. You cannot read any file beyond what's in the evidence above. If you need information that isn't in the evidence, say so via low confidence and \`null\` outputs — do not guess, do not fabricate steps you didn't take.

## Your job

1. Identify which client the request is for. Lean on \`triage.client_hints\` first; if a hint matches a client name (or its known aliases — check the client's \`index\` content), that's your client.
2. From the \`devHubs\` list, pick the alias(es) related to that client. Aliases usually contain the client name or a known abbreviation (e.g. \`krahn\`, \`leadventure-devhub\`).

## Output

Your FINAL message must be a single fenced JSON block in this exact shape, with no prose before or after the fences:

\`\`\`json
{
  "client": "<lowercase client name matching the vault folder, or null>",
  "confidence": "high | medium | low",
  "reasoning": "<one short sentence — see rules below>",
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
- "reasoning" MUST cite only what's in the evidence. Acceptable: "client_hints empty and no client name appears in raw_request"; "client_hints mentioned 'NRI' and the nri client is in the vault"; "two Dev Hubs in devHubs match the client (krahn, krahn-prod)". Unacceptable: any claim about searching orgs, looking up users, or verifying things you have no tools to verify.

Output only the fenced JSON block. No prose.`;

export const ROUTER_CONFIG: AgentConfig = {
  name: 'router',
  systemPrompt: ROUTER_SYSTEM_PROMPT,
  model: 'claude-haiku-4-5-20251001',
  tools: [],
  maxTurns: 2,
};

export async function gatherRouterContext(): Promise<RouterContext> {
  const clientsDir = `${env.VAULT_PATH}/clients`;
  const entries = await readdir(clientsDir, { withFileTypes: true });
  const clientDirs = entries.filter((e) => e.isDirectory());

  const clientResults = await Promise.all(
    clientDirs.map(async (entry) => {
      try {
        const content = await readFile(
          `${clientsDir}/${entry.name}/_index.md`,
          'utf8',
        );
        return { name: entry.name, index: content.trim() } as ClientEntry;
      } catch {
        return null;
      }
    }),
  );
  const clients = clientResults.filter((c): c is ClientEntry => c !== null);

  const { stdout } = await execFileAsync(SF_ORGS_SUMMARY_SCRIPT);
  const parsed = JSON.parse(stdout) as { orgs: OrgSummary[] };
  const devHubs = parsed.orgs.filter((o) => o.isDevHub);

  return { clients, devHubs };
}

export function buildRouterUserPrompt(
  rawRequest: string,
  context: RouterContext,
  triage?: TriagePayload,
): string {
  const evidence = {
    clients: context.clients,
    devHubs: context.devHubs,
    triage: triage ?? null,
    raw_request: rawRequest,
  };

  return `Evidence:

\`\`\`json
${JSON.stringify(evidence, null, 2)}
\`\`\`

Identify the client and recommended Dev Hub. Lean on triage.client_hints first.`;
}
