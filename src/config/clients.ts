import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { env } from './env.js';

export interface ClientConfig {
  name: string;
  repo_remote: string | null;
  repo_local: string | null;
  sf_alias: string | null;
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
 * Missing fields return null. The body of the file is otherwise free-form
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

  return { name, repo_remote, repo_local, sf_alias };
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
