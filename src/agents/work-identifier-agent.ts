import type { AgentConfig } from './types.js';
import type { TriagePayload } from './triage-agent.js';
import type { RouterPayload } from './router-agent.js';
import type { RolePermissionSet } from '../config/clients.js';

export type StoryPoints = 1 | 2 | 3 | 5 | 8 | 13;

export type FieldOperation = 'create' | 'update' | 'delete' | 'none';

export interface MetadataChange {
  object: string;
  field: string | null;
  field_type: string | null;
  operation: FieldOperation;
  notes: string | null;
}

export type PermissionStrategy = 'extend_existing' | 'create_new' | 'none';
export type FieldAccess = 'read' | 'edit';
export type ObjectAccess =
  | 'read'
  | 'create'
  | 'edit'
  | 'delete'
  | 'view_all'
  | 'modify_all';

export interface PermissionGrantField {
  object: string;
  field: string;
  access: FieldAccess;
}

export interface PermissionGrantObject {
  name: string;
  access: ObjectAccess[];
}

export interface PermissionGrant {
  permission_set: string;
  strategy: 'extend_existing' | 'create_new';
  rationale: string;
  fields: PermissionGrantField[];
  objects: PermissionGrantObject[];
}

export interface WorkIdentifierPayload {
  work_classification: string;
  metadata_changes: MetadataChange[];
  permission_strategy: PermissionStrategy;
  permission_grants: PermissionGrant[];
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
  "permission_strategy": "extend_existing | create_new | none",
  "permission_grants": [
    {
      "permission_set": "<API name of an existing role permset OR proposed new permset name>",
      "strategy": "extend_existing | create_new",
      "rationale": "<one short phrase: why this permset for these grants>",
      "fields": [
        { "object": "<SObject>", "field": "<Field API name>", "access": "read | edit" }
      ],
      "objects": [
        { "name": "<SObject>", "access": ["read", "create", "edit", "delete", "view_all", "modify_all"] }
      ]
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
- "metadata_changes" enumerates every distinct schema mutation (objects, fields, validation rules, flows, classes, layouts, etc). If the work is doc-only or pure access-granting, return [] and explain in execution_notes.
- **Profile metadata is forbidden.** \`object\` MUST NEVER be \`"Profile"\` and \`metadata_changes\` MUST NEVER reference a profile or a profile XML path. Any access-grant intent (read/edit access for a role or user, FLS, object permissions, app/tab visibility) belongs in \`permission_grants[]\` (see Permission set policy below), not here. The Execution agent is also blocked from touching profile XML, so emitting profile work guarantees a failed pipeline.

Permission set policy:
- The user message includes a "Role permission set registry" section listing the client's existing role-based permsets. Treat that as the canonical access registry.
- Default to \`strategy: "extend_existing"\` against ONE of the registered permsets. Pick the role that best matches the request's intended audience ("Tonya as a sales user" → \`Sales_User_Account_Fields\`, etc).
- Only emit \`strategy: "create_new"\` when none of the registered permsets is a sensible fit. When you do, you MUST also emit a \`blocker\` ambiguity asking the human to confirm the new name and intended role (the orchestrator will not auto-accept new permsets).
- NEVER emit one-off feature-specific permsets ("Tonya_Field_Access", "Lead_Tier_Field_Access"). The point of the registry is fewer, broader role permsets — extend an existing one.
- If the request is purely a schema/code change with no access work needed (e.g. adding an internal-only Apex class), set \`permission_strategy: "none"\` and \`permission_grants: []\`.
- Field-level access goes in \`fields[]\` (one entry per field). Object-level CRUD goes in \`objects[]\`. Don't repeat field info inside objects[].
- If you propose multiple grants on different permsets (e.g. one extension + one new), each entry is its own \`permission_grants\` element with its own strategy.

- "story_points" uses the standard Fibonacci scale (1, 2, 3, 5, 8, 13). Anchors:
  - 1: trivial single-field add/edit, no flow/code, no tests.
  - 2: small field work touching 1 object, simple validation, no Apex.
  - 3: small flow change, multi-field add, simple LWC tweak.
  - 5: meaningful flow rewrite, new validation rule + dependent field, modest LWC.
  - 8: new Apex class with tests, multi-object change, new omni-channel routing.
  - 13: cross-cutting work touching code + flows + multiple objects, or anything with significant unknowns.
  Pick the lower number when in doubt; flag uncertainty as a complexity_factor instead.
- "complexity_factors" is a short list of things that make the work harder than baseline (e.g. "touches managed package", "needs new role permset", "requires data backfill", "no test coverage exists yet"). [] is fine.
- "execution_notes" is the handoff to the Execution agent. Aim for 2–4 sentences. Mention the order of operations, anything fragile, and how Execution will know it succeeded. If you're emitting permission_grants, name the specific files Execution should edit (e.g. "Edit force-app/main/default/permissionsets/Sales_User_Account_Fields.permissionset-meta.xml — add a fieldPermissions block for the new field").
- "ambiguities" follow the same rules as Triage: blocker=true ONLY if the missing answer would change what the Execution agent does. "Should the field label match the API name?" is not a blocker. "Is this a global or local picklist?" is. A \`create_new\` permission_strategy ALWAYS produces a blocker ambiguity.
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
  permissionSets: RolePermissionSet[],
): string {
  return `Triage payload:

\`\`\`json
${JSON.stringify(triage, null, 2)}
\`\`\`

Router payload:

\`\`\`json
${JSON.stringify(routed, null, 2)}
\`\`\`

Role permission set registry (extend one of these before proposing a new permset):

${formatPermissionSetRegistry(permissionSets)}

Original raw request:

${rawRequest}

Produce the Work Identifier JSON for this request.`;
}

export function buildWorkIdentifierResumePrompt(answer: string): string {
  return `The human has provided this answer to the ambiguity you flagged:

${answer}

Re-emit your structured JSON output. Update any fields the answer clarified, and remove the resolved ambiguity from the "ambiguities" list (or flip its "blocker" to false if it's now non-blocking). If your answer reveals new ambiguities you couldn't see before, list those instead.`;
}

function formatPermissionSetRegistry(sets: RolePermissionSet[]): string {
  if (sets.length === 0) {
    return [
      '_(No role permsets registered for this client yet — any access work',
      'will require strategy: "create_new" with a blocker ambiguity to',
      'confirm the proposed name and role.)_',
    ].join(' ');
  }
  return sets.map((p) => `- \`${p.name}\` — ${p.description}`).join('\n');
}
