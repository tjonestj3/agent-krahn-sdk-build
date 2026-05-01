import { authHeaders } from './auth.js';

/**
 * Shared polling helper for the request/respond CLIs.
 *
 * Hits GET /requests/:id every few seconds, prints stage transitions and
 * recent events to stderr as they happen, and returns the row once the
 * pipeline reaches a terminal status (awaiting_input | awaiting_review |
 * completed | failed).
 *
 * Designed for human use at a terminal — Ctrl-C to exit early, the pipeline
 * keeps running on the server.
 */

interface PollOptions {
  intervalMs?: number;
  timeoutMs?: number;
  baseUrl?: string;
}

interface PipelineSnapshot {
  pipeline: {
    id: string;
    status: string;
    current_stage: string | null;
    pr_url: string | null;
    [key: string]: unknown;
  };
  events: {
    event_type: string;
    stage: string | null;
    payload: unknown;
    created_at: string;
  }[];
}

const TERMINAL_STATUSES = new Set([
  'awaiting_input',
  'awaiting_review',
  'completed',
  'failed',
]);

export async function pollUntilTerminal(
  pipelineId: string,
  options: PollOptions = {},
): Promise<PipelineSnapshot> {
  const interval = options.intervalMs ?? 3000;
  const timeout = options.timeoutMs ?? 30 * 60 * 1000;
  const port = Number(process.env.PORT ?? 3000);
  const baseUrl = options.baseUrl ?? `http://localhost:${port}`;

  const start = Date.now();
  let lastStage: string | null | undefined = undefined;
  let lastEventCount = 0;

  while (true) {
    const snap = await fetchSnapshot(baseUrl, pipelineId);

    // Print new events since last poll.
    for (const ev of snap.events.slice(lastEventCount)) {
      printEvent(ev);
    }
    lastEventCount = snap.events.length;

    // Print stage transitions (in case events were missed between polls).
    if (snap.pipeline.current_stage !== lastStage) {
      lastStage = snap.pipeline.current_stage;
    }

    if (TERMINAL_STATUSES.has(snap.pipeline.status)) {
      printTerminal(snap);
      return snap;
    }

    if (Date.now() - start > timeout) {
      throw new Error(
        `polling timeout after ${timeout}ms; pipeline ${pipelineId} still running`,
      );
    }

    await sleep(interval);
  }
}

async function fetchSnapshot(baseUrl: string, id: string): Promise<PipelineSnapshot> {
  const res = await fetch(`${baseUrl}/requests/${id}`, {
    headers: authHeaders(),
  });
  if (!res.ok) {
    throw new Error(`GET /requests/${id} failed: ${res.status}`);
  }
  return (await res.json()) as PipelineSnapshot;
}

function printEvent(ev: PipelineSnapshot['events'][number]): void {
  const time = ev.created_at.replace('T', ' ').replace(/\..*$/, '');
  const stage = ev.stage ? `[${ev.stage}]` : '       ';
  console.error(`  ${time} ${stage} ${ev.event_type}`);
}

function printTerminal(snap: PipelineSnapshot): void {
  const { pipeline } = snap;
  console.error('');
  switch (pipeline.status) {
    case 'awaiting_input':
      console.error(
        `▸ paused at stage="${pipeline.current_stage}" — pipeline ${pipeline.id}`,
      );
      console.error(
        `Resume with: npm run respond -- ${pipeline.id} "your answer"`,
      );
      break;
    case 'awaiting_review':
      console.error(`▸ awaiting_review — pipeline ${pipeline.id}`);
      if (pipeline.pr_url) console.error(`  PR: ${pipeline.pr_url}`);
      break;
    case 'completed':
      console.error(`▸ completed — pipeline ${pipeline.id}`);
      break;
    case 'failed':
      console.error(`▸ FAILED — pipeline ${pipeline.id}`);
      break;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
