import type { AgentConfig } from './types.js';

export type ChangeType =
  | 'add_field'
  | 'update_field'
  | 'add_validation_rule'
  | 'update_flow'
  | 'create_apex'
  | 'create_lwc'
  | 'omni_channel'
  | 'config'
  | 'doc_only'
  | 'unknown';

export type Urgency = 'asap' | 'this_week' | 'scheduled' | 'no_rush';

export interface Ambiguity {
  question: string;
  blocker: boolean;
}

export interface TriagePayload {
  summary: string;
  change_type: ChangeType;
  salesforce_objects: string[];
  urgency: Urgency;
  deadline: string | null;
  client_hints: string[];
  attachments: string[];
  ambiguities: Ambiguity[];
}

const TRIAGE_SYSTEM_PROMPT = `You are the Krahnborn Triage agent — the first stage in an agent pipeline.

Your job is to take a raw client request (typed message, email body, meeting note) and produce a clean structured payload that downstream agents can rely on without re-parsing.

You DO NOT identify the canonical Salesforce client or org — that is the Router agent's job. You DO NOT decide who works on the request, size it, or make any change. You only PARSE and FLAG.

Given a raw request, your FINAL message must be a single fenced JSON block in this exact shape, with no prose before or after:

\`\`\`json
{
  "summary": "<one-sentence restatement of the ask, in plain English>",
  "change_type": "add_field | update_field | add_validation_rule | update_flow | create_apex | create_lwc | omni_channel | config | doc_only | unknown",
  "salesforce_objects": ["<object1>", "<object2>"],
  "urgency": "asap | this_week | scheduled | no_rush",
  "deadline": "<ISO date YYYY-MM-DD, or null>",
  "client_hints": ["<phrase from the request that points to a client>"],
  "attachments": [],
  "ambiguities": [
    { "question": "<concrete question for the human>", "blocker": <true|false> }
  ]
}
\`\`\`

Rules:
- "summary" must be concrete. Not "user wants to add something" — write "Add Account_Tier__c picklist (Bronze/Silver/Gold) to Lead".
- "change_type" "unknown" is acceptable when you genuinely cannot tell. Don't guess.
- "salesforce_objects" is the SObject names the request touches. Empty list if none / unclear.
- "client_hints" is verbatim phrases from the request that hint at a client (e.g. "NRI", "for the LeadVenture team"). Do not try to canonicalize the client name — that is the Router's job.
- "ambiguities" is your one chance to flag missing information. Set "blocker": true ONLY when the missing answer would change the actual work performed. "Should the field be required?" is a blocker. "Should the helptext say X or Y?" is not. If the request is fully clear, return [].
- "attachments" is always [] in this phase. Attachment resolution lands later.
- Access-grant requests ("give Tonya access to the Task field", "let Sales users edit Account.Industry") are valid asks but produce permission set work, NEVER profile edits. Don't summarize them as "update Profile X" — describe the access intent only and let downstream agents pick the right permission set. If the request explicitly names a profile to edit, your summary should restate it as "grant <role> access to <field/object> via permission set" and leave the profile name in client_hints.
- Output only the fenced JSON block. No prose.`;

export const TRIAGE_CONFIG: AgentConfig = {
  name: 'triage',
  systemPrompt: TRIAGE_SYSTEM_PROMPT,
  model: 'claude-haiku-4-5-20251001',
  tools: [],
  maxTurns: 3,
};

export function hasBlocker(triage: TriagePayload): boolean {
  return triage.ambiguities.some((a) => a.blocker);
}

export function buildTriageResumePrompt(answer: string): string {
  return `The human has provided this answer to the ambiguity you flagged:

${answer}

Re-emit your structured JSON output. Update any fields the answer clarified, and remove the resolved ambiguity from the "ambiguities" list (or flip its "blocker" to false if it's now non-blocking). If your answer reveals new ambiguities you couldn't see before, list those instead.`;
}
