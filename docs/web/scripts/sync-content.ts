// SPDX-License-Identifier: Apache-2.0

/**
 * Builds `content/` (gitignored) from this repository, before `next build`.
 *
 *   1. copy `docs/site/**` (the hand-written pages)
 *   2. turn `docs/ENV.md` into /self-hosting/environment-variables
 *   3. generate the API reference from `openapi.json`, which
 *      `../../scripts/export-openapi.ts` writes from the same checkout
 *
 * Fails on a link to the old `/docs/...` prefix: the site is served at the
 * domain root, so such a link only works through a redirect.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { generateFiles } from 'fumadocs-openapi';
import { createOpenAPI } from 'fumadocs-openapi/server';

const ROOT = resolve(import.meta.dir, '..');
const REPO = resolve(ROOT, '../..');
const SITE = resolve(REPO, 'docs/site');
const CONTENT = resolve(ROOT, 'content');
const OPENAPI_FILE = resolve(ROOT, 'openapi.json');

process.chdir(ROOT);

const readText = (path: string) => Bun.file(path).text();
const readJson = <T>(path: string): Promise<T> => Bun.file(path).json();

/** MDX reads `{` and `<` as syntax; ENV.md is plain Markdown. Leave code untouched. */
function toMdx(markdown: string): string {
  let inFence = false;
  return markdown
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return line
        .split(/(`[^`]*`)/)
        .map((part) =>
          part.startsWith('`')
            ? part
            : part.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/<(?![a-zA-Z/!])/g, '&lt;'),
        )
        .join('');
    })
    .join('\n');
}

async function assertNoDocsPrefixLinks() {
  const offenders: string[] = [];
  for await (const file of new Bun.Glob('**/*.{md,mdx}').scan(SITE)) {
    if (file === 'README.md') continue;
    const text = await readText(resolve(SITE, file));
    text.split('\n').forEach((line, i) => {
      if (/(\]\(|href=")\/docs\//.test(line)) offenders.push(`docs/site/${file}:${i + 1}`);
    });
  }
  if (offenders.length > 0) {
    throw new Error(
      `Links to /docs/... found; the site is served at the root, write /features/agents, not /docs/features/agents:\n  ${offenders.join('\n  ')}`,
    );
  }
}

/**
 * Rows `verify:env-docs` requires in ENV.md that no operator sets: build stamps
 * written by the image build, and internal tuning knobs.
 */
const INTERNAL_ENV_VARS = new Set([
  'APP_VERSION',
  'GIT_SHA',
  'RUN_WAIT_POLL_INTERVAL_MS',
  'REMOTE_RUN_BUFFER_FLUSH_MS',
  'CHAT_SELF_ORIGIN',
]);

/** Replaces ENV.md's own intro, which is written for contributors (the gate and its populations). */
const ENV_INTRO = [
  'Appstrate validates these variables at boot and refuses to start when one is invalid or a required one is missing; a name it does not know is ignored without a warning.',
  'A row tagged **[not in the Zod schema]** is read by a module, the sidecar or the agent runtime instead of the platform schema, and is still set in the platform environment.',
].join(' ');

async function writeEnvPage() {
  const raw = await readText(resolve(REPO, 'docs/ENV.md'));
  const tableStart = raw.indexOf('\n| Variable ');
  if (tableStart < 0) throw new Error('docs/ENV.md: the `| Variable |` table is missing.');
  const table = raw
    .slice(tableStart + 1)
    .split('\n')
    .filter((line) => !INTERNAL_ENV_VARS.has(/^\| `([A-Z0-9_]+)`/.exec(line)?.[1] ?? ''))
    .join('\n');
  const page = [
    '---',
    'title: Environment Variables',
    'description: Every environment variable Appstrate reads, with defaults and notes.',
    '---',
    '',
    toMdx(`${ENV_INTRO}\n\n${table}`),
    '',
  ].join('\n');
  await Bun.write(resolve(CONTENT, 'self-hosting/environment-variables.mdx'), page);
}

/**
 * Two things the renderer cannot take: an operation whose tag the document does
 * not declare, and the catch-all media type `*\/*` (the credential proxy).
 */
async function prepareSpec() {
  if (!existsSync(OPENAPI_FILE)) {
    throw new Error('openapi.json is missing: run `bun run content`, which writes it first.');
  }
  const spec = JSON.parse((await readText(OPENAPI_FILE)).replaceAll('"*/*"', '"application/octet-stream"'));
  // The API serves its spec with `servers: [{ url: "/" }]`, which the curl examples would
  // resolve against the docs host. Use the placeholder the hand-written pages use.
  spec.servers = [{ url: 'https://your-instance', description: 'Your Appstrate instance' }];
  const declared = new Set<string>((spec.tags ?? []).map((t: { name: string }) => t.name));
  for (const item of Object.values<Record<string, { tags?: string[] }>>(spec.paths)) {
    for (const op of Object.values(item)) {
      for (const tag of op?.tags ?? []) {
        if (!declared.has(tag)) {
          declared.add(tag);
          (spec.tags ??= []).push({ name: tag });
        }
      }
    }
  }
  await Bun.write(OPENAPI_FILE, JSON.stringify(spec, null, 2));
}

/**
 * Operation descriptions come from the OpenAPI spec as free Markdown (`{id}`,
 * `<token>`, ...) and `generateFiles` copies them into the MDX body as is.
 */
async function escapeGeneratedBodies(apiDir: string) {
  for await (const file of new Bun.Glob('*/*.mdx').scan(apiDir)) {
    const path = resolve(apiDir, file);
    const text = await readText(path);
    const end = text.indexOf('\n---\n', 4) + 5;
    const body = text
      .slice(end)
      .split('\n')
      .map((line) => (line.startsWith('<APIPage') || line.startsWith('{/*') ? line : toMdx(line)))
      .join('\n');
    await Bun.write(path, text.slice(0, end) + body);
  }
}

/** One landing page per tag, so `/api/<tag>` resolves and lists its operations. */
async function writeTagIndexes(apiDir: string) {
  for (const entry of readdirSync(apiDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = resolve(apiDir, entry.name);
    const meta = await readJson<{ title?: string; description?: string; pages?: string[] }>(
      resolve(dir, 'meta.json'),
    );
    const links = await Promise.all(
      (meta.pages ?? []).map(async (op) => {
        const title = /^title: (.*)$/m.exec(await readText(resolve(dir, `${op}.mdx`)))?.[1];
        return `- [${title ?? op}](/api/${entry.name}/${op})`;
      }),
    );
    const title = JSON.stringify(meta.title ?? entry.name);
    const description = JSON.stringify(meta.description ?? `${meta.title ?? entry.name} operations.`);
    await Bun.write(
      resolve(dir, 'index.mdx'),
      `---\ntitle: ${title}\ndescription: ${description}\n---\n\n${links.join('\n')}\n`,
    );
  }
}

/**
 * `generateFiles` rewrites `api/meta.json` with its own tag order. Keep the
 * hand-written one (guides first, then the tag groups in the order the docs
 * chose), drop entries that no longer exist, and append tags that are new.
 */
async function generateApiReference() {
  const apiDir = resolve(CONTENT, 'api');
  const metaPath = resolve(apiDir, 'meta.json');
  const handWritten = await readJson<{ pages: string[] }>(metaPath);

  await generateFiles({
    input: createOpenAPI({ input: ['./openapi.json'] }),
    output: apiDir,
    per: 'operation',
    groupBy: 'tag',
    meta: true,
    includeDescription: true,
  });

  await escapeGeneratedBodies(apiDir);
  await writeTagIndexes(apiDir);

  const generated = await readJson<{ pages: string[] }>(metaPath);
  const exists = (name: string) =>
    name.startsWith('---') ||
    name === '...' ||
    existsSync(resolve(apiDir, name)) ||
    existsSync(resolve(apiDir, `${name}.mdx`));
  const kept = handWritten.pages.filter(exists);
  const extra = generated.pages.filter((name) => !kept.includes(name));
  const pages = [...kept, ...(extra.length ? ['---More---', ...extra] : [])];
  await Bun.write(metaPath, JSON.stringify({ ...handWritten, pages }, null, 2));
}

await assertNoDocsPrefixLinks();
rmSync(CONTENT, { recursive: true, force: true });
mkdirSync(CONTENT, { recursive: true });
cpSync(SITE, CONTENT, {
  recursive: true,
  filter: (src) => src !== resolve(SITE, 'README.md'),
});
await writeEnvPage();
await prepareSpec();
await generateApiReference();
console.log(`content synced from ${relative(process.cwd(), SITE) || '.'}`);
