import { readFileSync } from 'node:fs';
import { authHeaders } from './auth.js';
import { pollUntilTerminal } from './poll.js';

const args = process.argv.slice(2);

if (args.length === 0) {
  console.error('Usage:');
  console.error('  npm run request -- "raw request text here"');
  console.error('  npm run request -- --file path/to/request.txt');
  console.error('  npm run request -- --source slack "raw text"');
  console.error('  npm run request -- --no-wait "raw text"   # submit and exit');
  console.error('');
  console.error('Submits a request to the running server (POST /requests),');
  console.error('then polls the pipeline until it reaches a terminal state.');
  console.error('Server must be running: npm run dev');
  process.exit(1);
}

let source = 'manual';
let wait = true;
let positional = args;

for (;;) {
  const head = positional[0];
  if (head === '--source' && positional[1]) {
    source = positional[1];
    positional = positional.slice(2);
    continue;
  }
  if (head === '--no-wait') {
    wait = false;
    positional = positional.slice(1);
    continue;
  }
  break;
}

const raw_request =
  positional[0] === '--file' && positional[1]
    ? readFileSync(positional[1], 'utf8')
    : positional.join(' ');

const port = Number(process.env.PORT ?? 3000);
const url = `http://localhost:${port}/requests`;

const res = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...authHeaders() },
  body: JSON.stringify({ source, raw_request }),
});

const body = (await res.json()) as {
  pipeline_id?: string;
  status?: string;
  error?: string;
};

if (!res.ok) {
  console.error(`POST ${url} failed: ${res.status}`);
  console.error(JSON.stringify(body, null, 2));
  process.exit(2);
}

const pipelineId = body.pipeline_id;
if (!pipelineId) {
  console.error('Server did not return pipeline_id');
  console.error(JSON.stringify(body, null, 2));
  process.exit(2);
}

console.error(`▸ submitted pipeline ${pipelineId} (status=${body.status})`);

if (!wait) {
  console.log(JSON.stringify(body, null, 2));
  process.exit(0);
}

const final = await pollUntilTerminal(pipelineId);
console.log(JSON.stringify(final, null, 2));
