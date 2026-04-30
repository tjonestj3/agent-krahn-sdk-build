# Krahnborn OS — Phase 0 Build Plan
*Drop this into Claude Code on your laptop to kick off the build.*

---

## Context (read first)

Building **Krahnborn OS**: an agent-driven backend that takes Salesforce client requests (from email, meetings, Slack) and routes them through specialized AI subagents that triage, identify the right client/org, attempt the work in a scratch org, open a PR for human review, and auto-generate release notes.

Full architecture is in `krahnborn-os-architecture.md`. **Read that first.** This doc is the actionable Phase 0 build plan only.

### Decisions already made — don't re-litigate

- **Agent runtime:** Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)
- **Server:** Node.js + TypeScript + Fastify
- **Database:** Supabase (managed Postgres)
- **Salesforce access:** Salesforce MCP for reads, SF CLI for writes (Phase 1+)
- **Pattern:** Event-driven hub. Pipelines are rows in DB. Server reacts to triggers, doesn't sit in long-running loops.

---

## Phase 0 Goal

A working server with **one endpoint** that:

1. Receives `POST /requests` with a raw client request (text + metadata)
2. Creates a `pipelines` row in Supabase with status `running`
3. Runs a single subagent (the **Router**) using Claude Agent SDK
4. Router uses Salesforce MCP to look up which client/org this request is for
5. Updates the pipeline row with the routed client + status `completed`
6. Returns the result as JSON

**That's it.** No email integration, no Slack, no execution, no PRs. Prove the loop works end-to-end.

**Definition of done:** I can `curl` the endpoint with a test request, see the pipeline row in the Supabase dashboard go from `running` → `completed`, and get the correct client back in the response.

---

## Build Steps

### 1. Scaffold the project
```bash
mkdir krahnborn-os && cd krahnborn-os
git init
npm init -y
npm install fastify @anthropic-ai/claude-agent-sdk @supabase/supabase-js dotenv
npm install -D typescript @types/node tsx
npx tsc --init
```

### 2. File structure
```
krahnborn-os/
├── src/
│   ├── index.ts                  # Fastify app entry
│   ├── routes/
│   │   └── requests.ts           # POST /requests handler
│   ├── agents/
│   │   ├── runner.ts             # Wraps Agent SDK query() calls
│   │   └── router-agent.ts       # Router subagent definition
│   ├── db/
│   │   ├── client.ts             # Supabase client init
│   │   └── pipelines.ts          # Pipeline CRUD helpers
│   └── config/
│       └── env.ts                # Env var validation
├── .env                          # gitignored
├── .env.example                  # committed
└── package.json
```

### 3. Environment variables (`.env`)
```
ANTHROPIC_API_KEY=
SUPABASE_URL=
SUPABASE_SERVICE_KEY=          # service role key — bypasses RLS, server-side only
SALESFORCE_INSTANCE_URL=
SALESFORCE_ACCESS_TOKEN=        # or whatever the SF MCP needs
PORT=3000
```

### 4. Supabase setup
Create a new Supabase project. In the SQL editor, run:

```sql
create table pipelines (
  id uuid primary key default gen_random_uuid(),
  source text not null,                    -- 'email' | 'slack' | 'manual'
  raw_request text not null,
  client_id text,                          -- populated by router (lowercase vault folder name)
  dev_hub_alias text,                      -- populated by router (sf CLI alias of the Dev Hub)
  org_type text,                           -- 'production' | 'sandbox' | 'scratch' (Phase 0 always 'scratch')
  status text not null default 'running',  -- running | awaiting_input | awaiting_review | completed | failed
  session_id text,                         -- Agent SDK session id for resuming
  current_stage text,                      -- 'router' | 'work_identifier' | 'executor' | etc.
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table pipeline_events (
  id uuid primary key default gen_random_uuid(),
  pipeline_id uuid references pipelines(id) on delete cascade,
  event_type text not null,                -- 'created' | 'stage_started' | 'stage_completed' | 'human_response' | etc.
  stage text,
  payload jsonb,
  created_at timestamptz default now()
);

create index pipeline_events_pipeline_id_idx on pipeline_events(pipeline_id);
create index pipelines_status_idx on pipelines(status);
```

For Phase 0, leave RLS off (we're calling with service key from server only).

### 5. Define the Router subagent

In `src/agents/router-agent.ts`:

```typescript
import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';

export const routerAgent: AgentDefinition = {
  description: 'Identifies which client and Salesforce org a request belongs to.',
  prompt: `You are the Krahnborn Router.

Given a raw client request, your job is to:
1. Identify which client this is for (NRI, Stellar Digital, Meridian, or unknown)
2. Determine which Salesforce org applies (production, sandbox, or scratch)
3. Use the Salesforce MCP to verify the client exists and pull recent context

Return a JSON object with shape:
{
  "client_id": "...",
  "client_name": "...",
  "org_type": "production" | "sandbox" | "scratch",
  "confidence": "high" | "medium" | "low",
  "reasoning": "brief explanation"
}

If you cannot confidently identify the client, set client_id to null and confidence to "low".`,
  tools: ['Read', 'Grep', /* Salesforce MCP tools added via mcpServers */],
  model: 'sonnet',
};
```

### 6. Wire up the runner

In `src/agents/runner.ts`:

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';
import { routerAgent } from './router-agent';

export async function runRouter(rawRequest: string) {
  const result = await query({
    prompt: `Route this request:\n\n${rawRequest}`,
    options: {
      agents: { router: routerAgent },
      // Add Salesforce MCP server config here when ready
      // mcpServers: { salesforce: { ... } },
      maxTurns: 10,
    },
  });

  // Iterate through messages, find the final assistant message, parse JSON
  let finalText = '';
  let sessionId: string | undefined;

  for await (const msg of result) {
    if (msg.type === 'assistant') {
      // Capture text from assistant messages
      const textBlocks = msg.message.content.filter((b: any) => b.type === 'text');
      finalText = textBlocks.map((b: any) => b.text).join('\n');
    }
    if (msg.type === 'result') {
      sessionId = msg.session_id;
    }
  }

  // Parse JSON out of finalText (strip code fences if present)
  const cleaned = finalText.replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(cleaned);

  return { ...parsed, session_id: sessionId };
}
```

### 7. The endpoint

In `src/routes/requests.ts`:

```typescript
import { FastifyPluginAsync } from 'fastify';
import { supabase } from '../db/client';
import { runRouter } from '../agents/runner';

export const requestsRoute: FastifyPluginAsync = async (app) => {
  app.post('/requests', async (req, reply) => {
    const { source, raw_request } = req.body as any;

    // 1. Create pipeline row
    const { data: pipeline, error } = await supabase
      .from('pipelines')
      .insert({ source, raw_request, status: 'running', current_stage: 'router' })
      .select()
      .single();

    if (error) return reply.code(500).send({ error: error.message });

    try {
      // 2. Run router
      const routed = await runRouter(raw_request);

      // 3. Update pipeline
      const { data: updated } = await supabase
        .from('pipelines')
        .update({
          client_id: routed.client_id,
          org_type: routed.org_type,
          session_id: routed.session_id,
          status: 'completed',
          current_stage: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', pipeline.id)
        .select()
        .single();

      // Log event
      await supabase.from('pipeline_events').insert({
        pipeline_id: pipeline.id,
        event_type: 'stage_completed',
        stage: 'router',
        payload: routed,
      });

      return reply.send({ pipeline: updated, routed });
    } catch (err: any) {
      await supabase
        .from('pipelines')
        .update({ status: 'failed' })
        .eq('id', pipeline.id);
      return reply.code(500).send({ error: err.message });
    }
  });
};
```

### 8. Test it

```bash
npm run dev   # add tsx watch script in package.json

curl -X POST http://localhost:3000/requests \
  -H "Content-Type: application/json" \
  -d '{
    "source": "manual",
    "raw_request": "Hey can you add a new field called Account_Tier__c to the Lead object for NRI? Picklist with Bronze/Silver/Gold."
  }'
```

You should see a JSON response with the routed client + a new row in the Supabase `pipelines` table.

---

## Open Questions (answer before starting)

- [ ] Which Salesforce org to point Phase 0 at — a personal dev org or a real client sandbox?
- [ ] Salesforce MCP server: which one? (Self-hosted? Anthropic-blessed? Custom?) — check the connectors list and docs
- [ ] Initial client list for the Router to know about — hard-code in the system prompt for Phase 0, or seed a `clients` table?
- [ ] Hosting for Phase 0 — local only, or push to a small VPS / Railway from day one?

---

## Phase 1 Preview (don't build yet)

Once Phase 0 is solid:

- Add Triage subagent (parses raw request into structured payload before router)
- Add Work Identifier subagent (classifies the work + sizes with story points)
- Add Execution subagent (uses SF CLI shell-out to spin scratch org, makes change, opens PR)
- Add `/inbox` route that returns all pipelines, sortable
- Pick **one work type** (e.g., "add a field to Lead") and prove the full chain end-to-end

---

## Working with Claude Code on this

Suggested kickoff prompt when you sit down:

> Read `krahnborn-os-architecture.md` and `krahnborn-os-phase-0-plan.md`. We're starting Phase 0. Walk me through step 1 (scaffold) and pause for me to confirm before moving to step 2. Don't skip ahead.

Then go step by step. Don't let it one-shot the whole thing — you want to understand each piece since you'll be living in this codebase.

Add a `CLAUDE.md` at the repo root once scaffolded so future Claude Code sessions have project context automatically.
