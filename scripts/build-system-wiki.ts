import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import {
  renderMarkdown,
  splitFrontmatter,
  escapeHtml,
  slugifyHeading,
} from './lib/markdown.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE_DIR = resolve(HERE, '..', 'docs', 'system-wiki');
const OUT_DIR = resolve(process.cwd(), 'wiki');
const OUT = join(OUT_DIR, 'system.html');

const GROUP_ORDER = [
  'Start here',
  'How it works',
  'Technical',
  'Operations',
  'Reference',
];

if (!existsSync(SOURCE_DIR)) {
  console.error(`No system-wiki source at ${SOURCE_DIR}.`);
  process.exit(1);
}

interface Page {
  slug: string;
  title: string;
  group: string;
  order: number;
  bodyHtml: string;
  toc: { id: string; text: string; level: number }[];
}

const files = readdirSync(SOURCE_DIR)
  .filter((f) => f.endsWith('.md'))
  .sort();

const pages: Page[] = files.map((filename) => {
  const raw = readFileSync(join(SOURCE_DIR, filename), 'utf8');
  const { frontmatter, body } = splitFrontmatter(raw);
  const title = String(frontmatter.title ?? filename.replace(/\.md$/, ''));
  const slug = String(frontmatter.slug ?? filename.replace(/^\d+-/, '').replace(/\.md$/, ''));
  const group = String(frontmatter.group ?? 'Reference');
  const order = typeof frontmatter.order === 'number' ? (frontmatter.order as number) : 0;
  const bodyHtml = renderMarkdown(body);
  const toc = extractToc(body);
  return { slug, title, group, order, bodyHtml, toc };
});

const groups = groupPages(pages);
const buildInfo = collectBuildInfo();

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, renderShell(pages, groups, buildInfo));
console.log(`Wrote ${OUT} (${pages.length} pages across ${Object.keys(groups).length} groups).`);
console.log(`Open: file://${OUT}`);

interface BuildInfo {
  commit: string;
  branch: string;
  commitDate: string;
  fileCounts: Record<string, number>;
  recentCommits: { sha: string; subject: string }[];
}

function collectBuildInfo(): BuildInfo {
  const sh = (cmd: string): string => {
    try {
      return execSync(cmd, { encoding: 'utf8' }).trim();
    } catch {
      return '';
    }
  };

  const fileCounts = countByExt([
    'src',
    'bin',
    'scripts',
    'test',
    'db/migrations',
    'docs',
  ]);

  const recentRaw = sh('git log -10 --pretty=format:%h::%s');
  const recentCommits = recentRaw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, ...rest] = line.split('::');
      return { sha: sha ?? '', subject: rest.join('::') };
    });

  return {
    commit: sh('git rev-parse --short HEAD'),
    branch: sh('git rev-parse --abbrev-ref HEAD'),
    commitDate: sh('git log -1 --pretty=format:%ci'),
    fileCounts,
    recentCommits,
  };
}

function countByExt(dirs: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    walk(d, (p) => {
      const ext = p.match(/\.([A-Za-z0-9]+)$/)?.[1] ?? 'other';
      counts[ext] = (counts[ext] ?? 0) + 1;
    });
  }
  return counts;
}

function walk(dir: string, cb: (path: string) => void): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, cb);
    else cb(p);
  }
}

function extractToc(body: string): Page['toc'] {
  const out: Page['toc'] = [];
  for (const line of body.split('\n')) {
    const m = line.match(/^(#{2,3})\s+(.*)$/);
    if (!m) continue;
    const level = m[1]!.length;
    const text = m[2]!.trim();
    out.push({ id: slugifyHeading(text), text, level });
  }
  return out;
}

function groupPages(pages: Page[]): Record<string, Page[]> {
  const groups: Record<string, Page[]> = {};
  for (const p of pages) {
    if (!groups[p.group]) groups[p.group] = [];
    groups[p.group]!.push(p);
  }
  for (const list of Object.values(groups)) {
    list.sort((a, b) => a.order - b.order);
  }
  return groups;
}

function renderShell(
  pages: Page[],
  groups: Record<string, Page[]>,
  build: BuildInfo,
): string {
  const sortedGroups = Object.keys(groups).sort(
    (a, b) =>
      (GROUP_ORDER.indexOf(a) === -1 ? 99 : GROUP_ORDER.indexOf(a)) -
      (GROUP_ORDER.indexOf(b) === -1 ? 99 : GROUP_ORDER.indexOf(b)),
  );

  const sidebar = sortedGroups
    .map(
      (g) => `
        <div class="group">
          <div class="group-title">${escapeHtml(g)}</div>
          <ul>
            ${(groups[g] ?? [])
              .map(
                (p) =>
                  `<li class="nav-item" data-slug="${escapeHtml(p.slug)}">${escapeHtml(p.title)}</li>`,
              )
              .join('')}
          </ul>
        </div>`,
    )
    .join('\n');

  const pagesJson = JSON.stringify(
    pages.map((p) => ({
      slug: p.slug,
      title: p.title,
      group: p.group,
      bodyHtml: p.bodyHtml,
      toc: p.toc,
    })),
  ).replace(/</g, '\\u003c');

  const buildInfoJson = JSON.stringify(build).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Krahnborn OS — System Wiki</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; height: 100%; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif; color: #1f2328; background: #f6f8fa; }
  .app { display: grid; grid-template-columns: 280px 1fr 240px; height: 100vh; }
  aside { background: #fff; border-right: 1px solid #d0d7de; overflow-y: auto; display: flex; flex-direction: column; }
  aside header { padding: 20px 16px 12px; border-bottom: 1px solid #d0d7de; }
  aside h1 { margin: 0; font-size: 17px; letter-spacing: -0.01em; }
  aside .subtitle { font-size: 12px; color: #57606a; margin-top: 2px; }
  .search { padding: 10px 14px; border-bottom: 1px solid #d0d7de; }
  .search input { width: 100%; padding: 6px 10px; border: 1px solid #d0d7de; border-radius: 6px; font-size: 13px; }
  .nav { flex: 1; overflow-y: auto; padding: 8px 0 24px; }
  .group { margin-top: 12px; }
  .group-title { padding: 6px 16px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: #57606a; font-weight: 600; }
  .group ul { list-style: none; margin: 0; padding: 0; }
  .nav-item { padding: 6px 16px 6px 18px; font-size: 13px; cursor: pointer; border-left: 3px solid transparent; }
  .nav-item:hover { background: #f6f8fa; }
  .nav-item.active { background: #ddf4ff; border-left-color: #0969da; color: #0969da; font-weight: 500; }
  main { overflow-y: auto; padding: 32px 56px 96px; max-width: 880px; }
  main h1 { margin-top: 0; font-size: 30px; letter-spacing: -0.02em; padding-bottom: 8px; border-bottom: 1px solid #d0d7de; }
  main h2 { font-size: 21px; margin-top: 32px; padding-bottom: 4px; border-bottom: 1px solid #eaeef2; letter-spacing: -0.01em; }
  main h3 { font-size: 16px; margin-top: 24px; color: #1f2328; }
  main h4 { font-size: 14px; margin-top: 18px; color: #57606a; text-transform: uppercase; letter-spacing: 0.04em; }
  main p { line-height: 1.65; }
  main blockquote { margin: 0; padding: 8px 16px; border-left: 4px solid #d0d7de; color: #57606a; background: #fff; }
  main code { background: #eff1f3; padding: 0.1em 0.4em; border-radius: 4px; font-size: 0.9em; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  main pre.code { background: #0d1117; color: #e6edf3; padding: 14px 16px; border-radius: 8px; overflow-x: auto; font-size: 13px; }
  main pre.code code { background: transparent; padding: 0; color: inherit; }
  main table { border-collapse: collapse; width: 100%; margin-top: 8px; background: #fff; }
  main th, main td { border: 1px solid #d0d7de; padding: 6px 12px; text-align: left; font-size: 13px; vertical-align: top; }
  main th { background: #f6f8fa; }
  main hr { border: none; border-top: 1px solid #d0d7de; margin: 24px 0; }
  main a { color: #0969da; }
  .toc { padding: 32px 16px; font-size: 12px; border-left: 1px solid #d0d7de; background: #fff; overflow-y: auto; }
  .toc-title { text-transform: uppercase; letter-spacing: 0.06em; color: #57606a; font-weight: 600; font-size: 11px; margin-bottom: 8px; }
  .toc ul { list-style: none; margin: 0; padding: 0; }
  .toc li { padding: 3px 0; }
  .toc li.h3 { padding-left: 12px; }
  .toc a { color: #57606a; text-decoration: none; }
  .toc a:hover { color: #0969da; }
  .stamp { padding: 12px 16px; border-top: 1px solid #d0d7de; font-size: 11px; color: #57606a; line-height: 1.5; }
  .stamp code { background: #eff1f3; padding: 1px 4px; border-radius: 3px; }
</style>
</head>
<body>
<div class="app">
  <aside>
    <header>
      <h1>Krahnborn OS</h1>
      <div class="subtitle">System Wiki</div>
    </header>
    <div class="search"><input id="q" type="search" placeholder="Filter pages…" autocomplete="off"></div>
    <nav class="nav" id="nav">${sidebar}</nav>
    <div class="stamp" id="stamp"></div>
  </aside>
  <main id="main"></main>
  <div class="toc" id="toc"><div class="toc-title">On this page</div><ul id="toc-list"></ul></div>
</div>
<script>
  const PAGES = ${pagesJson};
  const BUILD = ${buildInfoJson};
  const main = document.getElementById('main');
  const tocList = document.getElementById('toc-list');
  const stamp = document.getElementById('stamp');

  function escape(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  }

  function show(slug) {
    const p = PAGES.find((x) => x.slug === slug) ?? PAGES[0];
    if (!p) return;
    main.innerHTML = p.bodyHtml;
    document.querySelectorAll('.nav-item').forEach((el) => {
      el.classList.toggle('active', el.dataset.slug === p.slug);
    });
    tocList.innerHTML = (p.toc || [])
      .map((t) => '<li class="h' + t.level + '"><a href="#' + t.id + '">' + escape(t.text) + '</a></li>')
      .join('');
    history.replaceState(null, '', '#' + p.slug);
    main.scrollTop = 0;
  }

  document.getElementById('nav').addEventListener('click', (e) => {
    const li = e.target.closest('.nav-item');
    if (li) show(li.dataset.slug);
  });

  document.getElementById('q').addEventListener('input', (e) => {
    const term = e.target.value.toLowerCase().trim();
    document.querySelectorAll('.nav-item').forEach((el) => {
      const hay = el.textContent.toLowerCase();
      el.style.display = !term || hay.includes(term) ? '' : 'none';
    });
    document.querySelectorAll('.group').forEach((g) => {
      const visible = Array.from(g.querySelectorAll('.nav-item')).some((it) => it.style.display !== 'none');
      g.style.display = visible ? '' : 'none';
    });
  });

  stamp.innerHTML = 'Built from <code>' + escape(BUILD.commit) + '</code> on <code>' + escape(BUILD.branch) + '</code><br>' + escape(BUILD.commitDate);

  const initial = decodeURIComponent(location.hash.slice(1));
  show(initial || PAGES[0]?.slug);
</script>
</body>
</html>`;
}
