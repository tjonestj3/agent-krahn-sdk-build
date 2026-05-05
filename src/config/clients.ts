import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { env } from './env.js';

export interface RolePermissionSet {
  name: string;
  description: string;
}

export interface ClientConfig {
  name: string;
  repo_remote: string | null;
  repo_local: string | null;
  sf_alias: string | null;
  permission_sets: RolePermissionSet[];
}

/**
 * Reads ~/vault/clients/<name>/_index.md and pulls a small set of structured
 * fields out of plain markdown. Format expected:
 *
 *   ## Org
 *   - `sf` alias: `krahn-admin`
 *
 *   ## Repo
 *   - Remote: git@github.com:org/repo.git
 *   - Local: ~/Salesforce/KRAHN/Krahn-Agent-Project
 *
 *   ## Permission sets
 *   - `Sales_User_Account_Fields` — Sales reps. Custom Account fields...
 *   - `Field_Tech_Operations` — Field technicians; case + work order data.
 *
 * Missing fields return null / []. The body of the file is otherwise free-form
 * markdown for human reading and Router agent context.
 */
export async function loadClientConfig(name: string): Promise<ClientConfig> {
  const path = `${env.VAULT_PATH}/clients/${name}/_index.md`;
  const md = await readFile(path, 'utf8');

  const repo_remote = matchLine(md, /^\s*-\s+Remote:\s*(.+?)\s*$/m);
  const repo_local_raw = matchLine(md, /^\s*-\s+Local:\s*(.+?)\s*$/m);
  const repo_local = repo_local_raw ? expandHome(repo_local_raw) : null;
  const sf_alias = matchLine(
    md,
    /^\s*-\s+`?sf`?\s+alias:\s*`?([A-Za-z0-9_\-]+)`?/im,
  );

  const permission_sets = parsePermissionSets(md);

  return { name, repo_remote, repo_local, sf_alias, permission_sets };
}

function parsePermissionSets(md: string): RolePermissionSet[] {
  // Find the "## Permission sets" section and parse bullets like:
  //   - `Sales_User_Account_Fields` — Sales reps. ...
  //   - Sales_User_Account_Fields - Sales reps. ...
  // We accept either em-dash, en-dash, or a plain hyphen as the separator
  // between the permset name and its description, and the name may or may
  // not be backtick-wrapped.
  //
  // Implementation note: scan line-by-line rather than regex-match the
  // whole section. JavaScript regex doesn't have a `\Z` end-of-string
  // anchor and a multiline-flag `$` lookahead won't reliably terminate at
  // EOF when the Permission sets section is the last in the file.
  const lines = md.split('\n');
  let inSection = false;
  const out: RolePermissionSet[] = [];
  const headingRe = /^##\s+(.*)$/;
  const bulletRe = /^\s*-\s+`?([A-Za-z0-9_]+)`?\s*[—–-]\s*(.+?)\s*$/;

  for (const line of lines) {
    const heading = line.match(headingRe);
    if (heading) {
      inSection = /^Permission\s*sets\s*$/i.test(heading[1]!.trim());
      continue;
    }
    if (!inSection) continue;
    const bullet = line.match(bulletRe);
    if (bullet && bullet[1] && bullet[2]) {
      out.push({ name: bullet[1], description: bullet[2] });
    }
  }
  return out;
}

function matchLine(text: string, re: RegExp): string | null {
  const m = text.match(re);
  return m && m[1] ? m[1].trim() : null;
}

function expandHome(p: string): string {
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  if (p === '~') return homedir();
  return p;
}
