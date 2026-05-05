---
title: Hard rules
slug: hard-rules
group: Technical
order: 6
---

# Hard rules

These are enforced in code or in prompt+orchestrator combos. They cannot be opted out of from inside an agent.

## 1. No profile metadata, ever

**Where enforced:**
- Triage prompt forbids restating access intent as profile work.
- Work Identifier prompt forbids `Profile` as a `metadata_changes.object`.
- Execution prompt forbids editing `*.profile-meta.xml` or any `/profiles/` path.
- Orchestrator post-PR diff guard (`src/execution/guard.ts`) inspects `git diff --name-only origin/main...<branch>` and **closes any PR** whose changes touch profile metadata. Then `force-with-lease` resets the branch to `origin/main` and pauses the pipeline so the agent can be resumed with the violation as its prompt.

**Why:** profile XML is dangerous to maintain at scale, and per-org Sales/Standard profiles often differ from environment to environment. Permission sets are additive, easier to revert, and easier to audit.

## 2. Dev Hub-only Router

**Where enforced:** `src/agents/router-agent.ts` system prompt — Router only ever recommends orgs with `isDevHub: true`. Real work always runs in a scratch org spun from a Dev Hub.

**Why:** scratch orgs are isolated, expirable, and a clean substrate for testing the agent's metadata edits before a human reviews the PR.

## 3. Single client repo per active execution

**Where enforced:** `src/execution/repo-lock.ts`. An in-memory async mutex keyed on `client_id` wraps `setupExecutionEnvironment + runExecution` and `rehydrateExecutionContext + resumeExecution`.

**Why:** `setupExecutionEnvironment` writes a project-local `target-org` config and creates a feature branch. Two pipelines for the same client without a lock would stomp each other.

## 4. Role permset extension first

**Where enforced:** `src/agents/work-identifier-agent.ts` system prompt — Work Identifier MUST default to `extend_existing` against one of the registered permsets in `vault/clients/<name>/_index.md`. `create_new` always emits a blocker ambiguity so the human confirms.

**Why:** the trap with permission sets is making one per feature; the registry forces the agent to think in terms of *roles*, not *features*. The human can grow the registry as new roles emerge, but the pipeline can't quietly create `Tonya_Account_Tier_Field_Access` permsets.

## 5. Agent runtime lockdown

**Where enforced:** `src/agents/runner.ts` — every `query()` is invoked with:

- `mcpServers: {}`
- `strictMcpConfig: true`
- `settingSources: []`
- `tools: [...]` and `allowedTools: [...]` matching the per-agent `AgentConfig`

**Why:** the agent's runtime should depend only on what's in code, not on the operator's local Claude Code config. Adding an MCP locally must not change pipeline behavior.

## 6. Bearer auth on internal routes

**Where enforced:** `src/middleware/auth.ts`. `/requests`, `/respond`, `/requests/:id` all require `Authorization: Bearer ${KRAHNBORN_API_TOKEN}`. `/health`, `/slack/*`, `/github/*` are public but signature-verified.

**Why:** the server runs on a single port; a typoed firewall rule shouldn't expose every endpoint to the internet.

## 7. No Salesforce data exfiltration

**Where enforced:**
- `bin/sf-orgs-summary.sh` strips access tokens before output reaches the LLM.
- `bin/scratch-query.sh` strips `attributes` blocks from SOQL results.
- `bin/scratch-describe.sh` returns only `{ name, label, custom, fields[] }` from describes.

**Why:** raw `sf org list --json` includes refresh tokens; raw describes are 50KB+. The wrappers exist so the agent's transcript stays safe and small.

## 8. Forbidden destructive shell ops

**Where enforced:** Execution agent prompt rules. The agent is told:

- never `git reset --hard`
- never `git push --force` (only the orchestrator's diff guard uses `--force-with-lease`, on its own branches)
- never `sf org delete` or `sf org logout`
- never target any org but the scratch alias provided

These are prompt-level guardrails, not code-level. Phase 2+ should consider intercepting Bash via SDK hooks for stronger enforcement.
