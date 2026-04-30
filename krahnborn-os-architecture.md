# Krahnborn OS — Agent Pipeline Architecture

## Vision

A unified backend system ("Krahnborn OS") that ingests client requests from any channel, routes them through specialized AI agents, executes work in the appropriate Salesforce environment, opens a PR for human review, and auto-generates release notes and client communications. The team interacts through a shared frontend (eventually React-based) so everyone uses the same tooling, MCPs, and data — no fragmented setups, no lost context.

---

## Mental Model

- **The LLM (Opus, Sonnet, Haiku) is the brain.** It reasons.
- **The agent is the harness around the brain.** It gives the LLM a loop: call tools, see results, decide next step, repeat until done.
- **A "router agent" and an "execution agent" are the same engine** with different system prompts, different tool access, and sometimes different models.
- **Claude Code is one such harness** with a CLI front-end. The **Claude Agent SDK** is the same harness exposed as a library you embed in your own backend.

This mental model is what unlocks the simplicity below.

---

## The Pipeline (End-to-End Flow)

```
Client Request (email, meeting, Slack)
        ↓
   [Intake Layer]
        ↓
   [Triage Subagent]    — structures and enriches the request
        ↓
   [Router Subagent]    — identifies the client + correct org
        ↓
   [Work Identifier]    — classifies the work type, sizes it
        ↓
   [Execution Subagent] — spins up scratch org, attempts work, opens PR
        ↓
   [Human Review]       — PR reviewed and merged
        ↓
   [Doc Subagent]       — release notes, client comms auto-drafted
```

Each box is a Claude Agent SDK subagent — same engine, different config.

---

## Stage Breakdown

### 1. Intake Layer
**Purpose:** Capture every inbound request without losing context.

**Sources:** Email (Gmail MCP), meeting notes/transcripts (Otter, Fathom, Granola), Slack, manual entry.

**Output:** A normalized "Request" object — raw text + source metadata + timestamp — written to the state store.

---

### 2. Triage Subagent
**Purpose:** Make sense of raw input.

- Parse into structured payload: client, requested change, urgency, attachments
- Flag ambiguous requests for human clarification

**Tools/MCPs:** Gmail, Drive, Calendar.
**Model:** Haiku or Sonnet (cheap, fast).

---

### 3. Router Subagent
**Purpose:** Match the request to the right client and Salesforce org.

- Query client registry (NRI, Stellar Digital, Meridian, etc.)
- Pull recent Salesforce context (related cases, recent changes)
- Decide: production org? sandbox? scratch?

**Tools/MCPs:** Salesforce MCP (read), client metadata store.
**Model:** Sonnet.

---

### 4. Work Identifier Subagent
**Purpose:** Classify work and prep execution context.

- Categorize: Flow, Apex, Omni-Channel, LWC, doc-only, etc.
- Estimate complexity using the **Krahnborn story point Skill**
- Decide: agent attempts it, or escalate to human?

**Output:** Structured work order for the execution stage.
**Model:** Sonnet.

---

### 5. Execution Subagent
**Purpose:** Do the actual work.

- Spin up scratch org for the client
- Pull latest from client repo
- Apply the change using SFDX CLI scripts (the "battle-tested toolkit")
- Run tests
- Open a PR with summary

**Tools/MCPs:** SFDX CLI (via shell), GitHub MCP, Salesforce MCP (write).
**Model:** Opus (this is where you want the smartest brain).

---

### 6. Documentation Subagent
**Purpose:** Close the loop with polished outputs.

- Generate release notes from PR diff + work order
- Draft client emails using approved templates
- Update internal knowledge base

**Skills:** Release note format, client comm tone, KB structure.
**Model:** Sonnet.

---

## Technical Architecture

### Core Components

**1. Orchestration Server**
- Node.js + TypeScript (Fastify or Express)
- Runs on a Linux server you control
- Receives requests, kicks off Agent SDK runs, manages state, exposes API to the team

**2. Claude Agent SDK as the Agent Runtime**
- `@anthropic-ai/claude-agent-sdk` (TypeScript) or `claude-agent-sdk` (Python)
- Provides the agent loop, tool calling, MCP integration, context management — out of the box
- Subagents defined declaratively in the `agents` parameter
- Each subagent: own description, system prompt, restricted tool list, optional model override
- Each subagent runs in an isolated context window — no cross-pollution

This is the single biggest simplifier. You're not rolling your own orchestration — the SDK does it.

**3. State Store**
- Postgres (or SQLite to start)
- Tracks every request, every stage transition, every agent decision, every PR/output
- This is what makes "never lose context" real

**4. MCP Layer (already partially in place)**
- Salesforce MCP, Gmail, Drive, Calendar, GitHub, Slack
- Configured at the SDK level so all subagents (with permission) can use them

**5. Skills Layer**
- Krahnborn-specific institutional knowledge as portable skill files
- Examples: story point framework, release note template, omni-channel patterns, client onboarding flows
- Lives in version control alongside the orchestration server
- Available to whichever subagents need them

**6. Frontend (Phase 4+)**
- React app wrapping the orchestration server's API
- Dashboards: requests in flight, PRs awaiting review, draft outputs
- Manual trigger UI, monitoring views
- Auth: basic auth → OAuth (Google) when going public

---

### How Subagents Talk to Each Other

They don't talk directly. The **Agent SDK parent agent** orchestrates them.

You define a top-level "Krahnborn Pipeline" agent with `Task` in its allowed tools and your subagents in the `agents` config. The parent reads the request, decides which subagents to invoke and in what order, passes their outputs forward, and returns the final result.

For more deterministic flows (where you don't want the LLM choosing the order), the orchestration server can call subagents explicitly in sequence — same SDK, same subagents, just with the server playing conductor instead of a parent agent.

**Start with explicit sequencing. Move to LLM orchestration when the workflow gets variable enough to need it.**

---

## Operational Layer — The Krahnborn Hub

The pipeline describes how a single request flows through agents. The operational layer is how the **team lives with the system day to day** — how requests get in, how you get pinged when something needs you, how your responses flow back.

This is what turns "an agent pipeline" into "Krahnborn OS."

### Four Components

**1. Inbound Trigger**
- Dedicated alias (e.g., `requests@krahnborn.com`) or a Gmail label auto-applied via filter
- Gmail Push API (via Cloud Pub/Sub) notifies the server the moment new mail lands
- MVP fallback: cron job polls Gmail every 2 minutes for unread + labeled messages
- On trigger: server creates a pipeline row in Postgres and kicks off orchestration in the background

**2. Pipeline State Machine**
Every pipeline row carries a status:

| Status | Meaning |
|---|---|
| `running` | Subagents actively working |
| `awaiting_input` | Paused — needs a human answer to a question |
| `awaiting_review` | PR open — needs human merge/comments |
| `completed` | Done, docs generated |
| `failed` | Error — needs investigation |

When a subagent hits `AskUserQuestion` or a permission gate, the orchestrator catches it, updates the row, saves the `session_id` + question text, and ends the call. **No process sits idle waiting for you.**

**3. Notifications + Inbox**

Two layers, both important:

- **Push (Slack)** — when status flips to `awaiting_input` or `awaiting_review`, server DMs the team. Example: "🟡 NRI Lead routing — Can't tell if prod or sandbox. Which?" — with a link or interactive buttons.
- **Pull (`/inbox` page)** — web view of every pending pipeline. Sort by client, age, urgency. This is where you go to clear the queue when you've got 20 minutes.

Slack is for "respond now while it's fresh." The inbox is for "let me batch through these."

**4. Response Routing**

When you answer:
- Slack thread reply, button click, or web form submission
- Server tags the response with `pipeline_id`, looks up `session_id`
- Calls `query({ resume: sessionId, prompt: yourAnswer })`
- Pipeline continues from where it paused

Slick version: Slack interactive buttons for simple choices ("NRI / Stellar / Meridian?"), web form for richer input. Whichever fits the question.

### The Mental Shift

The orchestrator is **not** a long-running process babysitting each pipeline. Each pipeline is a row in Postgres with a status and a `session_id`. The server only wakes up a pipeline when there's a trigger — new email, subagent finished, human responded. Between events, nothing runs.

That's what makes it cheap, scalable, and crash-resilient. If the server restarts, every pipeline is right where it left off in the database.

### Operational Flow

```
[Gmail push] ──┐
               ↓
        [Orchestrator API]
               ↓
       ┌── create pipeline row
       ├── run subagents until pause
       ├── update status, save session_id
       └── post to Slack DM (if needs human)
               ↓
       [Team member sees ping]
               ↓
   [Reply / tap button] ──→ [Slack webhook → server]
                                ↓
                       [Resume pipeline with answer]
                                ↓
                       [Continues to next subagent...]
                                ↓
                       [PR opened → GitHub webhook]
                                ↓
                       [On merge → resume → docs subagent]
                                ↓
                       [Pipeline complete, summary posted to Slack]
```

---

## Tech Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Server runtime | Node.js + TypeScript | Easiest React integration, great I/O |
| Web framework | Fastify or Express | Lightweight, well-documented |
| Agent runtime | **Claude Agent SDK** | Same engine as Claude Code, programmable, native subagents/MCP/skills |
| Database | **Supabase (managed Postgres)** | Postgres + Auth + Realtime + dashboard, all in one |
| Frontend | React + Tailwind | Matches what you already build |
| Hosting | Single Linux VPS (Hetzner, Railway, Fly) | Cheap, full control over the orchestration server |
| Realtime UI updates | Supabase Realtime subscriptions | Inbox auto-updates without polling |
| Auth | Supabase Auth (when frontend lands) | Already there; skip Clerk/Auth.js |

**Claude Code CLI** is great for *building* this system locally on your dev machine. The **Agent SDK** is what you embed in the running service. Same engine, different interface.

---

## Phased Rollout

### Phase 0 — Foundation (week 1–2)
- Stand up a Linux server (or run locally first)
- Spin up a Supabase project, define `pipelines` and `pipeline_events` tables
- Install Claude Agent SDK
- Wire up ONE MCP (Salesforce read) and ONE subagent (Router)
- Build a single API endpoint: POST a request → run Router → write pipeline row → return routed client
- Verify the team can hit it

### Phase 1 — One Vertical Slice (week 3–6)
- Pick ONE work type (e.g., "add a field to a Lead")
- Define Triage + Router + Work Identifier + Execution subagents
- Wire up GitHub MCP and SFDX CLI access
- Skip Documentation subagent for now
- Manual trigger via API endpoint
- **Build basic `/inbox` page** — list of pipelines with status
- **Goal:** end-to-end PR opened by an agent for one type of request, with a way to see what's in flight

### Phase 2 — Email Intake + Slack Loop (week 6–10)
- Gmail auto-trigger via push or polling on a dedicated label/alias
- Meeting notes ingestion (manual paste at first)
- **Slack DM notifications** when status flips to `awaiting_input` or `awaiting_review`
- **Reply-in-thread** to respond to agent questions → resumes pipeline
- Pipeline state machine fully wired

### Phase 3 — Expand Coverage (week 10–16)
- More work classifications
- Full client registry in Router
- Documentation subagent live with first templates
- First Krahnborn Skills written and version-controlled
- **GitHub webhook integration** — PR merged auto-resumes pipeline to docs stage

### Phase 4 — React Frontend (week 16+)
- Polished dashboard wrapping the `/inbox`
- Manual trigger UI, monitoring, audit log views
- **Slack interactive buttons** for structured choices
- **Custom interrupt UI** for rich approval flows (work order review, etc.)
- Auth + public exposure

### Phase 5 — Polish + Scale
- Better skills/templates
- Observability (logs, metrics, cost tracking — `max_budget_usd` per request)
- Team onboarding docs
- Workflow engine if needed (Temporal, Inngest)

---

## Open Questions to Resolve

- **Client metadata store:** Salesforce custom object? YAML in repo? Postgres table?
- **Approval gates:** Where is human approval required vs optional?
- **Rollback strategy:** If Execution Subagent makes a bad change, how do we revert cleanly?
- **Cost ceiling:** Per-request LLM budget? Need monitoring early.
- **Audit trail:** What level of logging is required for client-facing work?
- **Skill ownership:** Who writes/maintains Krahnborn Skills? Where do they live?

---

## Guiding Principles

1. **Start small, ship a vertical slice fast.** One work type, end-to-end, beats a half-built grand vision.
2. **The server is the source of truth.** Not individual laptops, not Claude Code sessions.
3. **Subagents are dumb pipes with focused jobs.** Narrow prompts, scoped tools.
4. **Human review stays in the loop.** Especially early — agents propose, humans dispose.
5. **Skills are how institutional knowledge scales.** If you find yourself explaining the same thing to the agent twice, write a Skill.
6. **Logs and state matter more than features.** You need to answer "what did the agent do, why, and when?"
7. **Don't roll your own agent loop.** The SDK exists. Use it.
8. **The hub is event-driven, not always-on.** Pipelines are rows in a database. The server only wakes them when something happens — email arrives, subagent finishes, human responds.
