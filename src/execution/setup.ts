import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadClientConfig } from '../config/clients.js';
import type { PipelineRow } from '../db/pipelines.js';
import type { WorkIdentifierPayload } from '../agents/work-identifier-agent.js';

const execFileAsync = promisify(execFile);

const SPIN_SCRATCH_SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../bin/spin-scratch.sh',
);

export interface ExecutionContext {
  client: string;
  repo_local: string;
  branch_name: string;
  scratch_org_alias: string;
  scratch_org_id: string | null;
  scratch_login_url: string | null;
  dev_hub_alias: string;
}

/**
 * Prepares the local environment so the Execution agent can do its work
 * inside a known-good state:
 *   1. Look up the client's repo path from the vault.
 *   2. Verify the working tree is clean (no surprise local edits).
 *   3. git fetch, checkout main, pull.
 *   4. Create a feature branch off main.
 *   5. Spin a scratch org from the recommended Dev Hub.
 *   6. Source-push current main into the scratch org so it mirrors prod.
 *   7. Set that scratch alias as the project-local default `target-org`.
 *
 * Throws on any step. The caller is expected to mark the pipeline failed
 * and surface the error.
 */
export async function setupExecutionEnvironment(
  pipeline: PipelineRow,
  workIdentifier: WorkIdentifierPayload,
): Promise<ExecutionContext> {
  if (!pipeline.client_id) {
    throw new Error('pipeline has no client_id; cannot prepare execution');
  }
  if (!pipeline.dev_hub_alias) {
    throw new Error('pipeline has no dev_hub_alias; cannot spin scratch');
  }

  const client = await loadClientConfig(pipeline.client_id);
  if (!client.repo_local) {
    throw new Error(
      `vault/clients/${pipeline.client_id}/_index.md is missing "Local:" repo path`,
    );
  }

  const cwd = client.repo_local;
  const shortId = pipeline.id.slice(0, 8);
  const slug = slugify(workIdentifier.work_classification).slice(0, 40);
  const branch = `krahnborn-os/${shortId}-${slug}`;
  const scratchAlias = `krahnborn-os-${shortId}`;

  await assertCleanTree(cwd);
  await git(cwd, ['fetch', 'origin']);
  await git(cwd, ['checkout', 'main']);
  await git(cwd, ['pull', '--ff-only', 'origin', 'main']);
  await git(cwd, ['checkout', '-b', branch]);

  const scratch = await spinScratch(cwd, pipeline.dev_hub_alias, scratchAlias);

  await sf(cwd, ['project', 'deploy', 'start', '--target-org', scratchAlias]);
  await sf(cwd, ['config', 'set', `target-org=${scratchAlias}`]);

  return {
    client: pipeline.client_id,
    repo_local: cwd,
    branch_name: branch,
    scratch_org_alias: scratchAlias,
    scratch_org_id: scratch.orgId,
    scratch_login_url: scratch.loginUrl,
    dev_hub_alias: pipeline.dev_hub_alias,
  };
}

interface SpinScratchResult {
  alias: string | null;
  orgId: string | null;
  username: string | null;
  expirationDate: string | null;
  loginUrl: string | null;
}

async function spinScratch(
  cwd: string,
  devHub: string,
  alias: string,
): Promise<SpinScratchResult> {
  const { stdout } = await execFileAsync(
    SPIN_SCRATCH_SCRIPT,
    [devHub, alias, '7'],
    { cwd, maxBuffer: 4 * 1024 * 1024 },
  );
  return JSON.parse(stdout) as SpinScratchResult;
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, maxBuffer: 4 * 1024 * 1024 });
}

async function sf(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('sf', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
}

async function assertCleanTree(cwd: string): Promise<void> {
  // Allow untracked files (typically managed-package output that gets
  // re-pulled on every scratch source-push). They don't represent
  // committed-but-uncommitted work, and `git checkout main` either ignores
  // them or fails loudly if they'd be overwritten — both of which are fine.
  // Modified, staged, deleted, or unmerged paths still trip the check —
  // those are real human work that we won't risk clobbering.
  const { stdout } = await execFileAsync(
    'git',
    ['status', '--porcelain', '--untracked-files=no'],
    { cwd },
  );
  if (stdout.trim().length > 0) {
    throw new Error(
      `working tree at ${cwd} has uncommitted tracked changes — commit or stash before running:\n${stdout}`,
    );
  }
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
