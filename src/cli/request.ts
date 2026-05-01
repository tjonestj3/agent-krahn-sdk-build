import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);

if (args.length === 0) {
  console.error('Usage:');
  console.error('  npm run request -- "raw request text here"');
  console.error('  npm run request -- --file path/to/request.txt');
  console.error('  npm run request -- --source slack "raw text"');
  console.error('');
  console.error('Submits a request to the running server (POST /requests).');
  console.error('Server must be running: npm run dev');
  process.exit(1);
}

let source = 'manual';
let positional = args;

if (args[0] === '--source' && args[1]) {
  source = args[1];
  positional = args.slice(2);
}

const raw_request =
  positional[0] === '--file' && positional[1]
    ? readFileSync(positional[1], 'utf8')
    : positional.join(' ');

const port = Number(process.env.PORT ?? 3000);
const url = `http://localhost:${port}/requests`;

const res = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ source, raw_request }),
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
  console.error(`▸ paused at stage="${outcome.stage}" — pipeline ${outcome.pipeline?.id}`);
  for (const b of outcome.blockers ?? []) {
    console.error(`  ? ${b.question}`);
  }
  console.error('');
  console.error(`Resume with: npm run respond -- ${outcome.pipeline?.id} "your answer"`);
} else if (outcome.status === 'completed') {
  console.error(`▸ completed — pipeline ${outcome.pipeline?.id}`);
}

console.log(JSON.stringify(body, null, 2));
