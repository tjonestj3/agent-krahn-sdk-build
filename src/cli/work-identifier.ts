import { readFileSync } from 'node:fs';
import { runTriage, runRouter, runWorkIdentifier } from '../agents/runner.js';

const args = process.argv.slice(2);

if (args.length === 0) {
  console.error('Usage:');
  console.error('  npm run work-identifier -- "raw request text here"');
  console.error('  npm run work-identifier -- --file path/to/request.txt');
  console.error('');
  console.error('Runs Triage → Router → Work Identifier in-process (no DB, no HTTP).');
  process.exit(1);
}

const rawRequest =
  args[0] === '--file' && args[1]
    ? readFileSync(args[1], 'utf8')
    : args.join(' ');

console.error('▸ Triage…');
const triage = await runTriage(rawRequest);

console.error('▸ Router…');
const routed = await runRouter(rawRequest, triage.data);

console.error('▸ Work Identifier…');
const wi = await runWorkIdentifier(rawRequest, triage.data, routed.data);

console.log(
  JSON.stringify(
    {
      triage: triage.data,
      routed: routed.data,
      work_identifier: wi.data,
      session_id: wi.sessionId,
    },
    null,
    2,
  ),
);
