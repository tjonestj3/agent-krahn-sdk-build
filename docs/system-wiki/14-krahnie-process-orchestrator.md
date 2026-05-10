---
title: Krahnie as Process Orchestrator
slug: krahnie-process-orchestrator
group: Operating Model
order: 14
---

# Krahnie as the Krahnborn Process Orchestrator

Captured: 2026-05-09  
Updated: 2026-05-10

## One-line idea

Krahnie should not merely be an agent that “does work.” Krahnie should be the orchestration layer that makes Krahnborn’s client-work process easy, consistent, auditable, and hard to skip.

> No work without a card. No code without a branch. No branch without a PR. No merge without validation. No delivery without documentation.

## Refined vision

The core value is not an autonomous Salesforce builder that tries to replace the consultant/admin/developer. The core value is a process coordinator that keeps every request moving through the right lane.

Requests can arrive from any source:

```text
Slack
Email
Meeting notes
Client portal
Manual entry
Webhook/API
```

Krahnie picks up the request, creates or updates the right card, enriches it with useful first-pass context, and then keeps the operational machinery moving as humans do the actual work.

The near-term goal is:

```text
Request comes in
  → Krahnie creates the card under the right client/org/project
  → Krahnie adds first-pass notes, estimate, due date, complexity, and likely impacted areas
  → human reviews/refines/assigns the card
  → human performs the Salesforce work in the normal dev box/admin workflow
  → card moves to Ready for Customer Review
  → Krahnie collects the changed metadata
  → Krahnie creates the branch, commits metadata, and opens the PR
  → human approves/merges the PR
  → CI/CD deploys to the right testing environment
  → card moves through customer testing/acceptance/deployment states
  → Krahnie documents the completed work
```

The agent becomes the guardrail, coordinator, and documentation engine — not necessarily the implementer.

## Why this matters

Krahnborn needs one standard delivery motion that is easy for developers, admins, consultants, and leadership to follow without everyone remembering every process step manually.

Instead of saying, “Please follow the workflow,” Krahnborn makes the agent-assisted workflow the easiest path:

```text
A request appears somewhere
  → Krahnie captures it as a card
  → Krahnie enriches the card enough for human review
  → the human does the right Salesforce work
  → Krahnie handles the Git/PR/CI/CD/documentation trail around that work
```

This keeps delivery auditable and consistent while still letting the human expert own judgment, implementation, and customer context.

## Target lifecycle

```text
Intake from any source
  → card created under correct client / org / project
  → AI first-pass enrichment added
       - summary
       - initial estimate
       - due-date suggestion or missing due-date flag
       - complexity
       - likely impacted Salesforce areas
       - acceptance notes / open questions
  → human reviews, refines, prioritizes, and assigns
  → human performs work in Salesforce/dev box
  → card moved to Ready for Customer Review
  → changed metadata is identified
       - manually attached/listed by the human, or
       - polled/retrieved from the dev box via Salesforce CLI
  → Krahnie creates feature branch/worktree as needed
  → Krahnie adds retrieved metadata to branch
  → Krahnie commits and opens PR with card context
  → human PR review/approval
  → merge to integration/partial branch
  → standard CI/CD deploys changed metadata to connected testing environment
  → card moves to Ready for Customer Testing
  → customer validates
  → card moves to Accepted / Waiting Deployment
  → Krahnie generates functional + technical documentation
  → production deployment/release process completes
  → request closed with docs and audit trail
```

## Operating model

### 1. Intake from anywhere

A messy request from any channel becomes a structured card. The source should not matter. Slack, email, meeting notes, a client portal, or a manual internal note should all enter the same delivery lane.

Example raw request:

```text
Client says partner users cannot finish onboarding.
```

Krahnie turns it into a card draft like:

```yaml
client: NRI
org_or_project: needs_confirmation
request_type: bug
priority: needs_confirmation
owner: unassigned
requested_by: <source/person>
due_date: needs_confirmation
complexity: initial_medium
summary: Partner users cannot complete onboarding
initial_notes:
  - Likely Salesforce access/configuration issue.
  - Confirm affected persona/profile/permission set.
  - Confirm whether this is production-blocking.
open_questions:
  - Is this happening in production or only sandbox?
  - Which partner profile, permission set, or persona is impacted?
  - Is this blocking go-live or normal operations?
```

The point is not to perfectly solve the request at intake. The point is to give the human reviewer a better starting card than a blank ticket.

### 2. Card enrichment, not heavyweight process ceremony

Krahnie can still perform useful first-pass reasoning, but it should show up as practical card enrichment rather than a visible process full of internal agent-stage ceremony.

The card should capture:

- correct client/account
- correct org/project/repo when knowable
- short business summary
- request type: bug, enhancement, config, security, data, deployment, support
- initial complexity/estimate
- suggested due date or missing due-date flag
- likely impacted Salesforce areas
- acceptance criteria / “done means” notes
- open questions/blockers
- suggested owner/skillset if obvious

Internally, Krahnie may use specialized reasoning, but externally the user experience is simply:

```text
Request in → useful card out → human can review and work.
```

### 3. Human-first implementation

Near term, humans still do the Salesforce work.

Implementation may happen through:

- Salesforce Setup UI
- a developer sandbox/dev box
- Salesforce CLI
- local metadata repo work
- a normal human admin/developer workflow

Krahnie’s job is to keep the implementation attached to the process lane:

```text
card → metadata capture → branch → commit → PR → CI/CD → customer testing → docs
```

Agent implementation can be added later for well-scoped changes, but the orchestration value exists even when the agent never changes a field itself.

### 4. Ready for Customer Review triggers metadata capture

When the human finishes the work, they move the card to a review-ready state such as:

```text
Ready for Customer Review
```

That status transition tells Krahnie:

```text
The Salesforce work is done enough to package, review, and deploy for testing.
```

Krahnie then gathers changed metadata through one of two paths:

#### Manual metadata handoff

The human can add metadata notes directly to the card, for example:

```yaml
metadata_to_capture:
  - CustomField: Account.Customer_Tier__c
  - PermissionSet: Sales_Manager
  - Layout: Account-Account Layout
```

#### Dev-box polling/retrieve

If the human worked in a dev box/sandbox, Krahnie can use Salesforce CLI from that environment to identify and retrieve recent metadata changes without requiring the human to list every metadata item explicitly.

The intent:

```text
Human does the work where they are productive.
Krahnie retrieves the metadata trail and turns it into a proper branch/PR.
```

### 5. Branch, commit, and PR orchestration

After metadata capture, Krahnie handles the Git mechanics behind the scenes:

```text
create feature branch
add retrieved metadata
commit with card/request context
open pull request
link PR back to card
summarize changes and testing notes
```

Branch examples:

```text
feature/KB-1042-partner-onboarding-validation
bugfix/KB-1043-account-trigger-null-check
config/KB-1044-case-routing-permissions
```

The PR should include a consistent template:

```md
Summary:

Request:
  KB-1042

Client / Org / Project:

Changes:

Metadata Captured:

Testing / Customer Review Notes:

Deployment Notes:

Rollback Notes:

Documentation:
  Functional:
  Technical:
```

Krahnie enforces the boring-but-important parts:

- request/card link
- summary of business impact
- changed metadata list
- validation notes
- CI/CD status
- deployment target
- rollback notes

### 6. PR approval and standard CI/CD

Krahnie should not replace normal review gates.

The intended process is:

```text
feature branch
  → PR opened by Krahnie
  → human review/approval
  → merge to integration/partial branch
  → standard CI/CD deploys changed metadata to connected testing environment
```

GitHub Actions or the existing deployment pipeline should handle deployment mechanics. Krahnie tracks state, updates the card, surfaces failures, and keeps card/PR/docs synchronized.

### 7. Customer testing and acceptance

After successful CI/CD deployment, the card should move into a testing state such as:

```text
Ready for Customer Testing
```

When the customer or internal reviewer accepts the change, the card moves to a later state such as:

```text
Accepted / Waiting Deployment
```

That status transition should trigger Krahnie’s documentation flow.

### 8. Documentation after acceptance

Once the work is accepted, Krahnie drafts or updates both functional and technical documentation.

Functional documentation answers:

```text
What changed for the business/user?
How does the new behavior work?
How should client users/admins use it?
What was validated by the customer?
```

Technical documentation answers:

```text
What metadata/code changed?
What architecture or dependency changed?
What permissions/personas are impacted?
What tests were run?
What deployment notes matter?
What is the rollback plan?
```

The documentation should be linked back to the card and PR so the request has a complete audit trail.

## State machine view

A practical card-state flow:

```text
New / Intake
  → Needs Human Review
  → Ready to Work / Assigned
  → In Progress
  → Ready for Customer Review
      triggers metadata capture + branch/commit/PR
  → PR Open / Internal Review
  → Ready for Customer Testing
      triggered by CI/CD deploy success
  → Accepted / Waiting Deployment
      triggers documentation
  → Deployed / Complete
```

The exact status names can match the tool Krahnborn chooses, but the automation hooks should attach to clear transitions.

## Identity and isolation

For team usage, each requester/reviewer/assignee should map to a Krahnborn identity for attribution and permissions.

Example mapping:

```yaml
users:
  alice@krahnborn.com:
    name: Alice
    github: alice-krahn
    role: consultant
    allowed_clients:
      - nri
      - acme
```

This supports attribution, permissions, approvals, notifications, and audit trails.

The important isolation unit is the request/card/branch, not the employee’s shell account.

Concurrency layers:

```text
Card/request id = process lane
Feature branch = version-control isolation
PR = review boundary
CI/CD = deployment automation
Repo/client lock = shared-environment protection
Approval gate = business safety
```

Locks are recommended for shared sandboxes, deploys, migrations, merges, production-like operations, and anything that mutates shared infrastructure.

## Agent roles

Krahnie can stay as one user-facing orchestration agent while internally delegating specialist responsibilities.

### Intake Krahnie

Creates cards, extracts required fields, asks missing business questions, and enriches the card with first-pass notes.

### Card PM Krahnie

Keeps cards updated, watches blockers, nudges assignees, tracks due dates, and reports status.

### Metadata Capture Krahnie

Retrieves changed Salesforce metadata from the dev box/sandbox or uses manually supplied metadata notes.

### Git/PR Krahnie

Creates branches, commits retrieved metadata, opens PRs, links PRs back to cards, and watches CI/CD.

### Reviewer Krahnie

Checks PR completeness, risk, tests, deployment notes, and Salesforce metadata sanity before or during human review.

### Documentation Krahnie

Writes functional and technical records after acceptance/deployment milestones.

### Builder Krahnie

Optional/future role: implements changes when agent execution is appropriate and the scope is safe.

## Feedback loop

A lightweight feedback loop should exist at the end, but it should not become noisy.

Suggested completion prompt:

```text
KB-1042 complete and documented:
Functional doc: <link>
Technical doc: <link>
PR: <link>

Optional feedback:
- `correction: ...` to fix this request/doc
- `lesson: ...` to remember for this client in future
- `process: ...` to improve the Krahnborn workflow
```

Feedback should be classified before being saved.

- `correction:` updates the current card/docs only.
- `lesson:` belongs in client-specific knowledge.
- `process:` should update templates, skills, or checklists that govern future work.
- Generic agent critique should be logged/aggregated and promoted only if repeated or explicitly durable.

## Adoption principle

Krahnie should make the right workflow easier than skipping it.

The adoption path should feel like:

```text
A request appears.
Krahnie turns it into a usable card.
A human does the work.
Krahnie packages, PRs, tracks, documents, and closes the loop.
```

## Summary

Krahnie is the operating-system layer for Krahnborn client work:

- normalizes intake from any source
- creates cards under the right client/org/project
- adds useful first-pass estimates, complexity, due-date notes, and AI notes
- supports human-first Salesforce implementation
- captures metadata after the human moves the card to review
- creates branches, commits metadata, and opens PRs
- lets human review and standard CI/CD handle deployment gates
- tracks customer testing and acceptance states
- documents accepted work
- learns from structured feedback

The vision is not “agents replace employees.”

The vision is:

> Agents make the standard Krahnborn process easier to follow than ignore.
