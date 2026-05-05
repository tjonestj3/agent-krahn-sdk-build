/**
 * Tiny markdown renderer + frontmatter parser shared by build-wiki.ts (per-
 * pipeline records) and build-system-wiki.ts (the system documentation site).
 *
 * Subset rendered:
 *   - ATX headings (# … ######)
 *   - Unordered lists (-, *, +) and ordered lists (1.)
 *   - Fenced code blocks (```)
 *   - Inline `code`, **bold**, *italic*, [text](url)
 *   - Blockquotes (> ...)
 *   - Pipe tables (GFM)
 *   - Horizontal rules (---)
 *
 * Not rendered (intentional): nested lists, footnotes, raw HTML, images.
 * Build records and the system-wiki source files don't use them.
 */

export function splitFrontmatter(raw: string): {
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

export function renderMarkdown(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';

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

    const hMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (hMatch) {
      const level = hMatch[1]!.length;
      const text = hMatch[2]!.trim();
      const id = slugifyHeading(text);
      out.push(`<h${level} id="${id}">${renderInline(text)}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^---+\s*$/.test(line)) {
      out.push('<hr>');
      i += 1;
      continue;
    }

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

    if (/^\|.*\|\s*$/.test(line) && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')) {
      const header = splitTableRow(line);
      i += 2;
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

    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i] ?? '')) {
        items.push((lines[i] ?? '').replace(/^\s*[-*+]\s+/, ''));
        i += 1;
      }
      out.push(`<ul>${items.map((it) => `<li>${renderInline(it)}</li>`).join('')}</ul>`);
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i] ?? '')) {
        items.push((lines[i] ?? '').replace(/^\s*\d+\.\s+/, ''));
        i += 1;
      }
      out.push(`<ol>${items.map((it) => `<li>${renderInline(it)}</li>`).join('')}</ol>`);
      continue;
    }

    if (line.trim() === '') {
      i += 1;
      continue;
    }

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
  let out = escapeHtml(s);
  out = out.replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`);
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => {
    const safeUrl = url.replace(/"/g, '&quot;');
    const isAnchor = safeUrl.startsWith('#');
    const target = isAnchor ? '' : ' target="_blank" rel="noopener"';
    return `<a href="${safeUrl}"${target}>${text}</a>`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  return out;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function slugifyHeading(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}
