import type { PipelineRow } from '../db/pipelines.js';
import { updatePipeline } from '../db/pipelines.js';
import { getRecipientUserId, slackClient } from './client.js';

interface Ambiguity {
  question: string;
  blocker: boolean;
}

const MAX_REQUEST_PREVIEW = 160;

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
  lines.push('', '_Reply in thread to answer._');

  await postToPipelineThread(pipeline, lines.join('\n'));
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

  await postToPipelineThread(pipeline, lines.join('\n'));
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
 */
async function postToPipelineThread(
  pipeline: PipelineRow,
  text: string,
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
