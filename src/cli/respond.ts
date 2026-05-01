import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);

if (args.length < 2) {
  console.error('Usage:');
  console.error('  npm run respond -- <pipeline_id> "your answer here"');
  console.error('  npm run respond -- <pipeline_id> --file path/to/answer.txt');
  console.error('');
  console.error('Server must be running: npm run dev');
  console.error('Find pipelines awaiting input: npm run pipelines -- awaiting_input');
  process.exit(1);
}

const [pipelineId, ...rest] = args;

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

const body = await res.json();

if (!res.ok) {
  console.error(`POST ${url} failed: ${res.status}`);
  console.error(JSON.stringify(body, null, 2));
  process.exit(2);
}

const outcome = body as {
  status: 'awaiting_input' | 'completed';
  stage?: string;
  pipeline?: { id: string };
  blockers?: { question: string; blocker: boolean }[];
};

if (outcome.status === 'awaiting_input') {
  console.error(`▸ paused again at stage="${outcome.stage}" — pipeline ${outcome.pipeline?.id}`);
  for (const b of outcome.blockers ?? []) {
    console.error(`  ? ${b.question}`);
  }
  console.error('');
  console.error(`Resume with: npm run respond -- ${outcome.pipeline?.id} "your answer"`);
} else if (outcome.status === 'completed') {
  console.error(`▸ completed — pipeline ${outcome.pipeline?.id}`);
}

console.log(JSON.stringify(body, null, 2));
