import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface DiffViolation {
  path: string;
  rule: 'profile_metadata';
  detail: string;
}

export interface DiffGuardResult {
  ok: boolean;
  violations: DiffViolation[];
  changedFiles: string[];
}

/**
 * Inspects the diff between origin/main and the agent's feature branch and
 * rejects categories of changes the pipeline is not allowed to ship.
 *
 * Currently enforced:
 *   - No edits, additions, or deletions to Profile metadata (anything under
 *     a `/profiles/` segment or ending in `.profile-meta.xml`). All access
 *     work has to go through permission sets.
 *
 * Returns the changed file list and any violations. The orchestrator is
 * responsible for what to do on violation (close PR, pause pipeline, etc).
 */
export async function inspectExecutionDiff(
  repoLocal: string,
  branchName: string,
): Promise<DiffGuardResult> {
  await execFileAsync('git', ['fetch', 'origin', 'main'], {
    cwd: repoLocal,
    maxBuffer: 4 * 1024 * 1024,
  }).catch(() => {});

  const { stdout } = await execFileAsync(
    'git',
    ['diff', '--name-only', `origin/main...${branchName}`],
    { cwd: repoLocal, maxBuffer: 4 * 1024 * 1024 },
  );

  const changedFiles = stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const violations: DiffViolation[] = [];
  for (const path of changedFiles) {
    if (isProfilePath(path)) {
      violations.push({
        path,
        rule: 'profile_metadata',
        detail:
          'Profile XML is forbidden; access changes must use a permission set.',
      });
    }
  }

  return { ok: violations.length === 0, violations, changedFiles };
}

function isProfilePath(path: string): boolean {
  return /(^|\/)profiles\//.test(path) || /\.profile-meta\.xml$/.test(path);
}

/**
 * Best-effort close of a PR with a comment explaining why. Used when the
 * post-execution diff guard finds something that violates a hard rule.
 */
export async function closePrWithReason(
  repoLocal: string,
  prUrl: string,
  reason: string,
): Promise<void> {
  await execFileAsync(
    'gh',
    ['pr', 'comment', prUrl, '--body', reason],
    { cwd: repoLocal, maxBuffer: 4 * 1024 * 1024 },
  ).catch(() => {});
  await execFileAsync('gh', ['pr', 'close', prUrl], {
    cwd: repoLocal,
    maxBuffer: 4 * 1024 * 1024,
  }).catch(() => {});
}

/**
 * Hard-reset the agent's feature branch back to origin/main and wipe the
 * remote copy. Used after a guard-rejected PR so the resumed agent starts
 * from a clean slate instead of inheriting forbidden commits.
 *
 * Best effort: any failure is logged and swallowed. The branch in question
 * is always orchestrator-owned (`krahnborn-os/<id>-<slug>`), never main.
 */
export async function resetFeatureBranch(
  repoLocal: string,
  branchName: string,
): Promise<void> {
  if (branchName === 'main') return;
  try {
    await execFileAsync('git', ['fetch', 'origin', 'main'], {
      cwd: repoLocal,
      maxBuffer: 4 * 1024 * 1024,
    });
    await execFileAsync('git', ['checkout', branchName], {
      cwd: repoLocal,
      maxBuffer: 4 * 1024 * 1024,
    });
    await execFileAsync('git', ['reset', '--hard', 'origin/main'], {
      cwd: repoLocal,
      maxBuffer: 4 * 1024 * 1024,
    });
    await execFileAsync(
      'git',
      ['push', '--force-with-lease', 'origin', branchName],
      { cwd: repoLocal, maxBuffer: 4 * 1024 * 1024 },
    ).catch(() => {});
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[diff-guard] resetFeatureBranch failed:', err);
  }
}
