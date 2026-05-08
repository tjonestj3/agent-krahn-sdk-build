import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PipelineRow } from '../db/pipelines.js';
import { updatePipeline } from '../db/pipelines.js';
import { getRecipientUserId, slackClient } from './client.js';

const execFileAsync = promisify(execFile);

interface Ambiguity {
  question: string;
  blocker: boolean;
}

const MAX_REQUEST_PREVIEW = 160;

export const CANCEL_PIPELINE_ACTION_ID = 'cancel_pipeline';
export const OPEN_PR_ACTION_ID = 'open_pr';

/** A single [Cancel] button targeting the given pipeline. */
function cancelButton(pipelineId: string): Record<string, unknown> {
  return {
    type: 'button',
    action_id: CANCEL_PIPELINE_ACTION_ID,
    style: 'danger',
    text: { type: 'plain_text', text: 'Cancel' },
    value: pipelineId,
    confirm: {
      title: { type: 'plain_text', text: 'Cancel this pipeline?' },
      text: { type: 'mrkdwn', text: 'It will move to status `cancelled`. This cannot be undone.' },
      confirm: { type: 'plain_text', text: 'Cancel pipeline' },
      deny: { type: 'plain_text', text: 'Keep it' },
    },
  };
}

/** A url-style [Open PR] button. URL buttons still emit interaction events;
 *  the interactions route ignores unknown action_ids. */
function openPrButton(prUrl: string): Record<string, unknown> {
  return {
    type: 'button',
    action_id: OPEN_PR_ACTION_ID,
    text: { type: 'plain_text', text: 'Open PR' },
    url: prUrl,
  };
}

export async function notifyAwaitingInput(
  pipeline: PipelineRow,
  stage: string,
  blockers: Ambiguity[],
  extra?: { blocked_on?: string },
): Promise<void> {
  const lines = [
    `🟡 Pipeline \`${shortId(pipeline.id)}\` paused at *${stage}*`,
    `> ${truncate(pipeline.raw_request, MAX_REQUEST_PREVIEW)}`,
    '',
  ];
  if (extra?.blocked_on) {
    lines.push(`*Blocked on:* ${extra.blocked_on}`, '');
  }
  if (blockers.length === 1) {
    lines.push(`*Q:* ${blockers[0]!.question}`);
  } else {
    blockers.forEach((b, i) => lines.push(`*Q${i + 1}:* ${b.question}`));
  }

  // For execution-stage pauses, give the human a one-click link to the
  // scratch org so they can verify state before answering. Best-effort —
  // skip silently if `sf` isn't on PATH or the org isn't reachable.
  if (stage === 'execution' && pipeline.scratch_org_alias) {
    const url = await scratchLoginUrl(pipeline.scratch_org_alias);
    if (url) {
      lines.push('', `*Scratch org:* <${url}|open in browser> (\`${pipeline.scratch_org_alias}\`)`);
    }
  }

  lines.push('', '_Reply in thread to answer._');

  const text = lines.join('\n');
  await postToPipelineThread(pipeline, text, [
    { type: 'section', text: { type: 'mrkdwn', text } },
    { type: 'actions', elements: [cancelButton(pipeline.id)] },
  ]);
}

async function scratchLoginUrl(alias: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'sf',
      ['org', 'open', '--target-org', alias, '--url-only', '--json'],
      { maxBuffer: 4 * 1024 * 1024, timeout: 10_000 },
    );
    const parsed = JSON.parse(stdout) as { result?: { url?: string } };
    return parsed.result?.url ?? null;
  } catch {
    return null;
  }
}

export async function notifyAwaitingReview(
  pipeline: PipelineRow,
): Promise<void> {
  const lines = [
    `✅ Pipeline \`${shortId(pipeline.id)}\` opened a PR`,
    `> ${truncate(pipeline.raw_request, MAX_REQUEST_PREVIEW)}`,
    '',
  ];
  if (pipeline.pr_url) lines.push(`*PR:* <${pipeline.pr_url}>`);
  if (pipeline.branch_name) lines.push(`*Branch:* \`${pipeline.branch_name}\``);
  if (pipeline.scratch_org_alias) {
    lines.push(`*Scratch org:* \`${pipeline.scratch_org_alias}\` (expires in ~7 days)`);
  }
  lines.push('', '_Review and merge when ready._');

  const text = lines.join('\n');
  const actions: Record<string, unknown>[] = [];
  if (pipeline.pr_url) actions.push(openPrButton(pipeline.pr_url));
  actions.push(cancelButton(pipeline.id));

  await postToPipelineThread(pipeline, text, [
    { type: 'section', text: { type: 'mrkdwn', text } },
    { type: 'actions', elements: actions },
  ]);
}

export async function notifyCompleted(pipeline: PipelineRow): Promise<void> {
  const lines = [
    `🎉 Pipeline \`${shortId(pipeline.id)}\` complete`,
    `> ${truncate(pipeline.raw_request, MAX_REQUEST_PREVIEW)}`,
    '',
  ];
  if (pipeline.pr_url) lines.push(`*Merged PR:* <${pipeline.pr_url}>`);
  if (pipeline.documentation_path) {
    lines.push(`*Build record:* \`${pipeline.documentation_path}\``);
  }
  lines.push('', '_The build is documented in the vault. Pipeline closed._');

  await postToPipelineThread(pipeline, lines.join('\n'));
}

export async function notifyFailed(
  pipeline: PipelineRow,
  errorMessage: string,
  stage?: string | null,
): Promise<void> {
  const lines = [
    `❌ Pipeline \`${shortId(pipeline.id)}\` failed${stage ? ` at *${stage}*` : ''}`,
    `> ${truncate(pipeline.raw_request, MAX_REQUEST_PREVIEW)}`,
    '',
    `*Error:* ${truncate(errorMessage, 400)}`,
  ];

  await postToPipelineThread(pipeline, lines.join('\n'));
}

/**
 * Post a DM to the resolved recipient, threading off the pipeline's first
 * notification if one already exists. Stores channel + root-thread ts on the
 * pipeline the first time we post for it. All errors are logged-and-swallowed
 * — notifier failures must not crash the orchestrator.
 *
 * `blocks` is optional: when provided, Slack renders the rich Block Kit
 * payload (e.g. with action buttons) and `text` becomes the notification
 * fallback. When omitted, only `text` is posted.
 */
async function postToPipelineThread(
  pipeline: PipelineRow,
  text: string,
  blocks?: Record<string, unknown>[],
): Promise<void> {
  try {
    const userId = await getRecipientUserId();
    if (!userId) {
      // eslint-disable-next-line no-console
      console.warn(
        `[notifier] no Slack recipient resolved (email/name fallback both failed) — skipping DM for pipeline ${pipeline.id}`,
      );
      return;
    }

    const isReply = !!pipeline.slack_message_ts;
    const channel = pipeline.slack_channel_id ?? userId;

    const res = await slackClient().chat.postMessage({
      channel,
      text,
      ...(blocks ? { blocks: blocks as never } : {}),
      ...(isReply && pipeline.slack_message_ts
        ? { thread_ts: pipeline.slack_message_ts }
        : {}),
    });

    if (!res.ok || !res.ts) {
      // eslint-disable-next-line no-console
      console.warn(`[notifier] chat.postMessage non-ok for pipeline ${pipeline.id}`, res);
      return;
    }

    // Only persist the FIRST message (the thread root) so M5 can find this
    // pipeline by thread_ts when the human replies.
    if (!isReply) {
      await updatePipeline(pipeline.id, {
        slack_channel_id: (res.channel as string | undefined) ?? channel,
        slack_message_ts: res.ts,
      }).catch((err) => {
        // eslint-disable-next-line no-console
        console.warn(`[notifier] failed to persist slack ts for pipeline ${pipeline.id}`, err);
      });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[notifier] DM failed for pipeline ${pipeline.id}`, err);
  }
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}
