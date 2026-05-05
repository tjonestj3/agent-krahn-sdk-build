import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';

const args = process.argv.slice(2);
const clientArg = args.find((a) => !a.startsWith('--'));

if (!clientArg) {
  console.error('Usage:');
  console.error('  npm run wiki -- <client-name>');
  console.error('');
  console.error('Reads ~/vault/clients/<client>/changes/*.md and writes a self-contained');
  console.error('HTML wiki to wiki/<client>.html. Open the file directly in your browser.');
  process.exit(1);
}

const VAULT = process.env.KRAHNBORN_VAULT_PATH ?? join(homedir(), 'vault');
const SOURCE = join(VAULT, 'clients', clientArg, 'changes');
const OUT_DIR = resolve(process.cwd(), 'wiki');
const OUT = join(OUT_DIR, `${clientArg}.html`);

if (!existsSync(SOURCE)) {
  console.error(`No changes directory at ${SOURCE} — nothing to build.`);
  console.error('(This is normal until the Documentation agent has written a build record.)');
  process.exit(0);
}

interface BuildRecord {
  filename: string;
  frontmatter: Record<string, string | number | null>;
  body: string;
  bodyHtml: string;
}

const files = readdirSync(SOURCE)
  .filter((f) => f.endsWith('.md'))
  .sort()
  .reverse();

const records: BuildRecord[] = files.map((filename) => {
  const raw = readFileSync(join(SOURCE, filename), 'utf8');
  const { frontmatter, body } = splitFrontmatter(raw);
  return {
    filename,
    frontmatter,
    body,
    bodyHtml: renderMarkdown(body),
  };
});

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, renderShell(clientArg, records));
console.log(`Wrote ${OUT} (${records.length} build${records.length === 1 ? '' : 's'}).`);
console.log(`Open: file://${OUT}`);

// ============================================================
// Frontmatter parser (YAML-lite — supports key: value lines only)
// ============================================================

function splitFrontmatter(raw: string): {
  frontmatter: Record<string, string | number | null>;
  body: string;
} {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { frontmatter: {}, body: raw };
  const fmText = m[1] ?? '';
  const body = m[2] ?? '';
  const fm: Record<string, string | number | null> = {};
  for (const line of fmText.split('\n')) {
    const lm = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!lm) continue;
    const key = lm[1]!;
    const val = (lm[2] ?? '').trim();
    if (val === 'null' || val === '') {
      fm[key] = null;
    } else if (/^-?\d+$/.test(val)) {
      fm[key] = Number(val);
    } else {
      fm[key] = val.replace(/^["']|["']$/g, '');
    }
  }
  return { frontmatter: fm, body };
}

// ============================================================
// Tiny markdown renderer (subset matching the build-record template)
// ============================================================

function renderMarkdown(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';

    // Fenced code block
    if (/^```/.test(line)) {
      const lang = line.slice(3).trim();
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i] ?? '')) {
        buf.push(lines[i] ?? '');
        i += 1;
      }
      i += 1;
      out.push(
        `<pre class="code"><code class="lang-${escapeHtml(lang)}">${escapeHtml(buf.join('\n'))}</code></pre>`,
      );
      continue;
    }

    // ATX heading
    const hMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (hMatch) {
      const level = hMatch[1]!.length;
      out.push(`<h${level}>${renderInline(hMatch[2]!.trim())}</h${level}>`);
      i += 1;
      continue;
    }

    // Horizontal rule
    if (/^---+\s*$/.test(line)) {
      out.push('<hr>');
      i += 1;
      continue;
    }

    // Blockquote (consecutive `> ...` lines)
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i] ?? '')) {
        buf.push((lines[i] ?? '').replace(/^>\s?/, ''));
        i += 1;
      }
      out.push(
        `<blockquote>${buf.map((l) => renderInline(l)).join('<br>')}</blockquote>`,
      );
      continue;
    }

    // Pipe table
    if (/^\|.*\|\s*$/.test(line) && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')) {
      const header = splitTableRow(line);
      i += 2; // skip separator
      const rows: string[][] = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i] ?? '')) {
        rows.push(splitTableRow(lines[i] ?? ''));
        i += 1;
      }
      out.push(
        `<table><thead><tr>${header.map((c) => `<th>${renderInline(c)}</th>`).join('')}</tr></thead><tbody>${rows
          .map(
            (r) =>
              `<tr>${r.map((c) => `<td>${renderInline(c)}</td>`).join('')}</tr>`,
          )
          .join('')}</tbody></table>`,
      );
      continue;
    }

    // Unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i] ?? '')) {
        items.push((lines[i] ?? '').replace(/^\s*[-*+]\s+/, ''));
        i += 1;
      }
      out.push(`<ul>${items.map((it) => `<li>${renderInline(it)}</li>`).join('')}</ul>`);
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i] ?? '')) {
        items.push((lines[i] ?? '').replace(/^\s*\d+\.\s+/, ''));
        i += 1;
      }
      out.push(`<ol>${items.map((it) => `<li>${renderInline(it)}</li>`).join('')}</ol>`);
      continue;
    }

    // Blank line — flush
    if (line.trim() === '') {
      i += 1;
      continue;
    }

    // Paragraph (consume until blank or block-level)
    const buf: string[] = [line];
    i += 1;
    while (i < lines.length && (lines[i] ?? '').trim() !== '' && !isBlockStart(lines[i] ?? '')) {
      buf.push(lines[i] ?? '');
      i += 1;
    }
    out.push(`<p>${buf.map((l) => renderInline(l)).join(' ')}</p>`);
  }

  return out.join('\n');
}

function isBlockStart(line: string): boolean {
  return (
    /^#{1,6}\s+/.test(line) ||
    /^\s*[-*+]\s+/.test(line) ||
    /^\s*\d+\.\s+/.test(line) ||
    /^>\s?/.test(line) ||
    /^```/.test(line) ||
    /^---+\s*$/.test(line) ||
    /^\|.*\|\s*$/.test(line)
  );
}

function splitTableRow(line: string): string[] {
  return line
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim());
}

function renderInline(s: string): string {
  // Escape first, then re-introduce markup with placeholders to avoid
  // double-escaping inside code spans.
  let out = escapeHtml(s);

  // Inline code (greedy single-line)
  out = out.replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`);

  // Links [text](url)
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => {
    const safeUrl = url.replace(/"/g, '&quot;');
    return `<a href="${safeUrl}" target="_blank" rel="noopener">${text}</a>`;
  });

  // Bold **text**
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // Italic *text* (after bold so they don't conflict)
  out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');

  return out;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ============================================================
// HTML shell — single self-contained file with all build data inline
// ============================================================

function renderShell(client: string, records: BuildRecord[]): string {
  const totalPoints = records.reduce(
    (acc, r) =>
      acc + (typeof r.frontmatter.story_points === 'number' ? (r.frontmatter.story_points as number) : 0),
    0,
  );

  const sidebarItems = records
    .map(
      (r, idx) => `
        <li class="record" data-idx="${idx}">
          <span class="rec-date">${escapeHtml(String(r.frontmatter.date ?? ''))}</span>
          <span class="rec-title">${escapeHtml(String(r.frontmatter.classification ?? r.filename))}</span>
          <span class="rec-points">${escapeHtml(String(r.frontmatter.story_points ?? ''))} pts</span>
        </li>`,
    )
    .join('\n');

  const recordsJson = JSON.stringify(records.map((r) => ({
    filename: r.filename,
    frontmatter: r.frontmatter,
    bodyHtml: r.bodyHtml,
  }))).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(client)} — Build Wiki</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; height: 100%; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif; color: #1f2328; background: #f6f8fa; }
  .app { display: grid; grid-template-columns: 320px 1fr; height: 100vh; }
  aside { background: #fff; border-right: 1px solid #d0d7de; overflow-y: auto; display: flex; flex-direction: column; }
  aside header { padding: 20px 16px 12px; border-bottom: 1px solid #d0d7de; }
  aside h1 { margin: 0 0 4px 0; font-size: 18px; }
  .stats { font-size: 12px; color: #57606a; }
  .search { padding: 12px 16px; border-bottom: 1px solid #d0d7de; }
  .search input { width: 100%; padding: 6px 10px; border: 1px solid #d0d7de; border-radius: 6px; font-size: 13px; }
  .records { list-style: none; margin: 0; padding: 0; flex: 1; overflow-y: auto; }
  .record { padding: 10px 16px; border-bottom: 1px solid #eaeef2; cursor: pointer; display: flex; flex-direction: column; gap: 2px; }
  .record:hover { background: #f6f8fa; }
  .record.active { background: #ddf4ff; border-left: 3px solid #0969da; padding-left: 13px; }
  .rec-date { font-size: 11px; color: #57606a; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .rec-title { font-size: 13px; font-weight: 500; }
  .rec-points { font-size: 11px; color: #57606a; }
  main { overflow-y: auto; padding: 32px 48px 64px; max-width: 920px; }
  main h1 { margin-top: 0; font-size: 28px; border-bottom: 1px solid #d0d7de; padding-bottom: 8px; }
  main h2 { font-size: 20px; margin-top: 28px; padding-bottom: 4px; border-bottom: 1px solid #eaeef2; }
  main h3 { font-size: 16px; margin-top: 20px; color: #57606a; }
  main p { line-height: 1.6; }
  main blockquote { margin: 0; padding: 8px 16px; border-left: 4px solid #d0d7de; color: #57606a; background: #fff; }
  main code { background: #eff1f3; padding: 0.1em 0.4em; border-radius: 4px; font-size: 0.9em; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  main pre.code { background: #0d1117; color: #e6edf3; padding: 14px 16px; border-radius: 8px; overflow-x: auto; }
  main pre.code code { background: transparent; padding: 0; color: inherit; }
  main table { border-collapse: collapse; width: 100%; margin-top: 8px; background: #fff; }
  main th, main td { border: 1px solid #d0d7de; padding: 6px 12px; text-align: left; font-size: 13px; }
  main th { background: #f6f8fa; }
  main hr { border: none; border-top: 1px solid #d0d7de; margin: 24px 0; }
  main a { color: #0969da; }
  .empty { padding: 32px; color: #57606a; text-align: center; }
  .meta { background: #fff; border: 1px solid #d0d7de; border-radius: 8px; padding: 12px 16px; margin-bottom: 24px; font-size: 13px; color: #57606a; display: flex; gap: 24px; flex-wrap: wrap; }
  .meta strong { color: #1f2328; }
</style>
</head>
<body>
<div class="app">
  <aside>
    <header>
      <h1>${escapeHtml(client)} — Build Wiki</h1>
      <div class="stats">${records.length} build${records.length === 1 ? '' : 's'} · ${totalPoints} pts shipped</div>
    </header>
    <div class="search">
      <input id="q" type="search" placeholder="Filter…" autocomplete="off">
    </div>
    <ul class="records" id="records">${sidebarItems || '<li class="empty">No builds yet.</li>'}</ul>
  </aside>
  <main id="main">${
    records.length === 0
      ? '<div class="empty"><p>No build records yet.</p><p>The Documentation agent writes one to <code>~/vault/clients/' + escapeHtml(client) + '/changes/</code> after every merged PR. Run <code>npm run wiki -- ' + escapeHtml(client) + '</code> again once they exist.</p></div>'
      : '<div class="empty">Select a build on the left.</div>'
  }</main>
</div>
<script>
  const RECORDS = ${recordsJson};
  const main = document.getElementById('main');
  const list = document.getElementById('records');
  const q = document.getElementById('q');

  function renderMeta(fm) {
    const items = [];
    if (fm.date) items.push('<span><strong>Date:</strong> ' + escape(fm.date) + '</span>');
    if (fm.story_points != null) items.push('<span><strong>Story points:</strong> ' + escape(fm.story_points) + '</span>');
    if (fm.pr_url) items.push('<span><strong>PR:</strong> <a href="' + fm.pr_url + '" target="_blank">#' + escape(fm.pr_number ?? '') + '</a></span>');
    if (fm.pipeline_id) items.push('<span><strong>Pipeline:</strong> <code>' + escape(String(fm.pipeline_id).slice(0, 8)) + '</code></span>');
    return '<div class="meta">' + items.join('') + '</div>';
  }

  function escape(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  }

  function show(idx) {
    const r = RECORDS[idx];
    if (!r) return;
    main.innerHTML = renderMeta(r.frontmatter) + r.bodyHtml;
    document.querySelectorAll('.record').forEach((el) => {
      el.classList.toggle('active', Number(el.dataset.idx) === idx);
    });
    history.replaceState(null, '', '#' + encodeURIComponent(r.filename));
  }

  list.addEventListener('click', (e) => {
    const li = e.target.closest('.record');
    if (li) show(Number(li.dataset.idx));
  });

  q.addEventListener('input', () => {
    const term = q.value.toLowerCase().trim();
    document.querySelectorAll('.record').forEach((el) => {
      const idx = Number(el.dataset.idx);
      const hay = (RECORDS[idx].frontmatter.classification + ' ' + RECORDS[idx].frontmatter.date).toLowerCase();
      el.style.display = !term || hay.includes(term) ? '' : 'none';
    });
  });

  // Open via hash (#filename) or first record
  const hash = decodeURIComponent(location.hash.slice(1));
  const initialIdx = hash ? RECORDS.findIndex((r) => r.filename === hash) : 0;
  if (RECORDS.length > 0) show(initialIdx >= 0 ? initialIdx : 0);
</script>
</body>
</html>`;
}
