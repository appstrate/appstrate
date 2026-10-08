// SPDX-License-Identifier: Apache-2.0

/**
 * Runs after `next build` on the static export in `out/`.
 *
 *   1. Writes the raw source of every page next to its HTML
 *      (`/get-started/introduction` -> `/get-started/introduction.md`), which
 *      the "Copy Markdown" button and the "Open in ..." links fetch.
 *   2. Checks every internal link and anchor of every page, and fails the
 *      build on the first broken one, so a dead link fails the pull request
 *      rather than a reader.
 *
 * Links under `/errors/` are served by the Pages Function in `functions/`,
 * not by a file, so they are not checked here.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const CONTENT = resolve(ROOT, 'content');
const OUT = resolve(ROOT, 'out');

if (!existsSync(OUT)) throw new Error('out/ is missing: run `next build` first.');

// 1. Markdown copies
let markdownCount = 0;
for await (const file of new Bun.Glob('**/*.mdx').scan(CONTENT)) {
  const slug = file.replace(/\.mdx$/, '').replace(/(^|\/)index$/, '');
  if (slug === '') continue;
  await Bun.write(resolve(OUT, `${slug}.md`), Bun.file(resolve(CONTENT, file)));
  markdownCount++;
}

// 2. Links and anchors
const decode = (value: string) => {
  const unescaped = value.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#x27;', "'");
  try {
    return decodeURIComponent(unescaped);
  } catch {
    return unescaped;
  }
};

/** The HTML file that serves a site path, as Cloudflare Pages resolves it. */
function fileFor(path: string): string | null {
  const clean = path.replace(/\/$/, '') || '/';
  if (clean === '/') return resolve(OUT, 'index.html');
  for (const candidate of [`${clean}.html`, `${clean}/index.html`, clean]) {
    const file = resolve(OUT, `.${candidate}`);
    if (existsSync(file)) return file;
  }
  return null;
}

const idsCache = new Map<string, Set<string>>();
async function idsOf(file: string): Promise<Set<string>> {
  let ids = idsCache.get(file);
  if (!ids) {
    const html = await Bun.file(file).text();
    ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => decode(m[1]!)));
    idsCache.set(file, ids);
  }
  return ids;
}

const broken: string[] = [];
let pageCount = 0;
let linkCount = 0;
for await (const page of new Bun.Glob('**/*.html').scan(OUT)) {
  if (page === '404.html' || page === '_not-found.html') continue;
  pageCount++;
  const pageFile = resolve(OUT, page);
  const html = await Bun.file(pageFile).text();
  for (const [, rawHref] of html.matchAll(/<a\s[^>]*?href="([^"]+)"/g)) {
    const href = decode(rawHref!);
    if (!href.startsWith('/') && !href.startsWith('#')) continue;
    if (href.startsWith('//') || href.startsWith('/errors/') || href === '/errors') continue;
    linkCount++;
    const [pathPart, anchor] = href.split('#', 2) as [string, string | undefined];
    const path = pathPart.split('?')[0]!;
    const target = path === '' ? pageFile : fileFor(path);
    if (!target) {
      broken.push(`/${page}: ${href} (no such page)`);
      continue;
    }
    if (anchor && target.endsWith('.html') && !(await idsOf(target)).has(anchor)) {
      broken.push(`/${page}: ${href} (no such anchor)`);
    }
  }
}

console.log(`${markdownCount} markdown copies written, ${linkCount} internal links checked across ${pageCount} pages`);
if (broken.length > 0) {
  console.error(`${broken.length} broken internal link(s):\n  ${broken.join('\n  ')}`);
  process.exit(1);
}
