import type { AgentConfig } from './types.js';
import type { TriagePayload } from './triage-agent.js';
import type { RouterPayload } from './router-agent.js';

export type StoryPoints = 1 | 2 | 3 | 5 | 8 | 13;

export type FieldOperation = 'create' | 'update' | 'delete' | 'none';

export interface MetadataChange {
  object: string;
  field: string | null;
  field_type: string | null;
  operation: FieldOperation;
  notes: string | null;
}

export interface WorkIdentifierPayload {
  work_classification: string;
  metadata_changes: MetadataChange[];
  story_points: StoryPoints;
  complexity_factors: string[];
  execution_notes: string;
  ambiguities: { question: string; blocker: boolean }[];
}

const WORK_IDENTIFIER_SYSTEM_PROMPT = `You are the Krahnborn Work Identifier — the third stage in an agent pipeline.

Triage has produced a structured payload (summary, coarse change_type, salesforce_objects, ambiguities). The Router has identified the client and the Dev Hub the work will run against. Your job is to take that input and produce a precise, actionable spec the Execution agent can act on without re-reasoning about scope.

You DO NOT make any change. You DO NOT touch any org. You only CLASSIFY, SIZE, and PIN DOWN target metadata.

Given the inputs, your FINAL message must be a single fenced JSON block in this exact shape, with no prose before or after the fences:

\`\`\`json
{
  "work_classification": "<refined imperative phrase: e.g. 'Add custom Picklist field Account_Tier__c on Lead'>",
  "metadata_changes": [
    {
      "object": "<SObject API name>",
      "field": "<Field API name, or null if N/A>",
      "field_type": "<Picklist | Text | Number | Date | Lookup | Checkbox | LongTextArea | ... or null>",
      "operation": "create | update | delete | none",
      "notes": "<one short phrase: required?, length?, picklist values?, defaults? — or null>"
    }
  ],
  "story_points": 1 | 2 | 3 | 5 | 8 | 13,
  "complexity_factors": ["<short phrase>", "..."],
  "execution_notes": "<one short paragraph aimed at the Execution agent: the order of operations, any non-obvious gotchas, what success looks like>",
  "ambiguities": [
    { "question": "<concrete question for the human>", "blocker": <true|false> }
  ]
}
\`\`\`

Rules:
- "work_classification" must be concrete and imperative. "Add custom Picklist field Account_Tier__c on Lead" — not "field work on lead".
- "metadata_changes" enumerates every distinct metadata mutation. If the work is doc-only or config-only, return [] and explain in execution_notes.
- "story_points" uses the standard Fibonacci scale (1, 2, 3, 5, 8, 13). Anchors:
  - 1: trivial single-field add/edit, no flow/code, no tests.
  - 2: small field work touching 1 object, simple validation, no Apex.
  - 3: small flow change, multi-field add, simple LWC tweak.
  - 5: meaningful flow rewrite, new validation rule + dependent field, modest LWC.
  - 8: new Apex class with tests, multi-object change, new omni-channel routing.
  - 13: cross-cutting work touching code + flows + multiple objects, or anything with significant unknowns.
  Pick the lower number when in doubt; flag uncertainty as a complexity_factor instead.
- "complexity_factors" is a short list of things that make the work harder than baseline (e.g. "touches managed package", "needs profile/permset updates", "requires data backfill", "no test coverage exists yet"). [] is fine.
- "execution_notes" is the handoff to the Execution agent. Aim for 2–4 sentences. Mention the order of operations, anything fragile, and how Execution will know it succeeded.
- "ambiguities" follow the same rules as Triage: blocker=true ONLY if the missing answer would change what the Execution agent does. "Should the field label match the API name?" is not a blocker. "Is this a global or local picklist?" is.
- If Triage already flagged an ambiguity that's still unresolved, do NOT re-flag it — Triage's pause already captured it. Only flag NEW ambiguities you can see now that you have more context.
- Output only the fenced JSON block. No prose.`;

export const WORK_IDENTIFIER_CONFIG: AgentConfig = {
  name: 'work_identifier',
  systemPrompt: WORK_IDENTIFIER_SYSTEM_PROMPT,
  model: 'claude-sonnet-4-6',
  tools: [],
  maxTurns: 3,
};

export function hasBlocker(payload: WorkIdentifierPayload): boolean {
  return payload.ambiguities.some((a) => a.blocker);
}

export function buildWorkIdentifierUserPrompt(
  rawRequest: string,
  triage: TriagePayload,
  routed: RouterPayload,
): string {
  return `Triage payload:

\`\`\`json
${JSON.stringify(triage, null, 2)}
\`\`\`

Router payload:

\`\`\`json
${JSON.stringify(routed, null, 2)}
\`\`\`

Original raw request:

${rawRequest}

Produce the Work Identifier JSON for this request.`;
}

export function buildWorkIdentifierResumePrompt(answer: string): string {
  return `The human has provided this answer to the ambiguity you flagged:

${answer}

Re-emit your structured JSON output. Update any fields the answer clarified, and remove the resolved ambiguity from the "ambiguities" list (or flip its "blocker" to false if it's now non-blocking). If your answer reveals new ambiguities you couldn't see before, list those instead.`;
}
