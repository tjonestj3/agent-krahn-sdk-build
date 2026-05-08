import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTriage, runWorkIdentifier } from '../../src/agents/runner.js';
import type { RouterPayload } from '../../src/agents/router-agent.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = resolve(HERE, 'snapshots');

const args = process.argv.slice(2);
const update = args.includes('--update');
const filter = args.find((a) => !a.startsWith('--'));

interface Case {
  name: string;
  request: string;
}

const cases: Case[] = JSON.parse(
  readFileSync(resolve(HERE, 'cases.json'), 'utf8'),
);

const cases_to_run = filter ? cases.filter((c) => c.name === filter) : cases;

if (cases_to_run.length === 0) {
  console.error(filter ? `no case named "${filter}"` : 'no cases to run');
  process.exit(1);
}

if (!existsSync(SNAPSHOT_DIR)) mkdirSync(SNAPSHOT_DIR, { recursive: true });

// Synthetic Router payload — the test harness skips the Router agent so it
// stays offline (no `sf org list`, no client config disk reads). Triage and
// Work Identifier are pure (no tools), so they're safe to invoke without DB
// or org access.
const ROUTED_FIXTURE: RouterPayload = {
  client: 'krahnborn',
  confidence: 'high',
  reasoning: 'test harness fixture — Router skipped',
  recommended_dev_hub: 'krahn',
  options: [],
};

let failures = 0;

for (const c of cases_to_run) {
  process.stdout.write(`▸ ${c.name} … `);
  try {
    const triage = await runTriage(c.request);
    const wi = await runWorkIdentifier(c.request, triage.data, ROUTED_FIXTURE);

    const snapshot = {
      request: c.request,
      triage: triage.data,
      work_identifier: wi.data,
    };

    const path = join(SNAPSHOT_DIR, `${c.name}.json`);
    if (existsSync(path) && !update) {
      const existing = JSON.parse(readFileSync(path, 'utf8'));
      const same = JSON.stringify(existing) === JSON.stringify(snapshot);
      if (same) {
        console.log('match');
      } else {
        failures += 1;
        console.log('DIFF (run with --update to overwrite)');
        console.log('  was:', JSON.stringify(existing).slice(0, 200), '…');
        console.log('  now:', JSON.stringify(snapshot).slice(0, 200), '…');
      }
    } else {
      writeFileSync(path, JSON.stringify(snapshot, null, 2) + '\n');
      console.log(existsSync(path) ? 'updated' : 'wrote');
    }
  } catch (err) {
    failures += 1;
    console.log('ERROR:', err instanceof Error ? err.message : String(err));
  }
}

if (failures > 0) {
  console.error(`\n${failures} case(s) failed or diverged.`);
  process.exit(1);
} else {
  console.error(`\n${cases_to_run.length} case(s) ok.`);
}
