import { readFileSync } from 'node:fs';
import { pollUntilTerminal } from './poll.js';

const args = process.argv.slice(2);

if (args.length < 2) {
  console.error('Usage:');
  console.error('  npm run respond -- <pipeline_id> "your answer here"');
  console.error('  npm run respond -- <pipeline_id> --file path/to/answer.txt');
  console.error('  npm run respond -- --no-wait <pipeline_id> "answer"   # submit and exit');
  console.error('');
  console.error('Submits the answer (POST /requests/:id/respond), then polls');
  console.error('until the pipeline reaches a terminal state.');
  console.error('');
  console.error('Server must be running: npm run dev');
  console.error('Find pipelines awaiting input: npm run pipelines -- awaiting_input');
  process.exit(1);
}

let wait = true;
let positional = args;

if (positional[0] === '--no-wait') {
  wait = false;
  positional = positional.slice(1);
}

if (positional.length < 2) {
  console.error('pipeline_id and answer are both required');
  process.exit(1);
}

const [pipelineId, ...rest] = positional;

const answer =
  rest[0] === '--file' && rest[1]
    ? readFileSync(rest[1], 'utf8')
    : rest.join(' ');

const port = Number(process.env.PORT ?? 3000);
const url = `http://localhost:${port}/requests/${pipelineId}/respond`;

const res = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ answer }),
});

const body = (await res.json()) as {
  pipeline_id?: string;
  status?: string;
  current_stage?: string | null;
  error?: string;
};

if (!res.ok) {
  console.error(`POST ${url} failed: ${res.status}`);
  console.error(JSON.stringify(body, null, 2));
  process.exit(2);
}

console.error(
  `▸ submitted answer for pipeline ${body.pipeline_id ?? pipelineId} (status=${body.status})`,
);

if (!wait) {
  console.log(JSON.stringify(body, null, 2));
  process.exit(0);
}

const final = await pollUntilTerminal(pipelineId!);
console.log(JSON.stringify(final, null, 2));
