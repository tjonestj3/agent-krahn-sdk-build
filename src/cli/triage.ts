import { readFileSync } from 'node:fs';
import { runTriage } from '../agents/runner.js';

const args = process.argv.slice(2);

if (args.length === 0) {
  console.error('Usage:');
  console.error('  npm run triage -- "raw request text here"');
  console.error('  npm run triage -- --file path/to/request.txt');
  process.exit(1);
}

const rawRequest =
  args[0] === '--file' && args[1]
    ? readFileSync(args[1], 'utf8')
    : args.join(' ');

const result = await runTriage(rawRequest);
console.log(JSON.stringify({ ...result.data, session_id: result.sessionId }, null, 2));
