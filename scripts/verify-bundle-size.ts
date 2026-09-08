#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * Gate — a size budget for the SPA bundle in `apps/web/dist`.
 *
 * `apps/web/vite.config.ts` carried `chunkSizeWarningLimit: 3700`, and that is
 * not a budget in any sense that can fail: it is a WARNING threshold, printed
 * to a build log nobody reads, at 3.7 MB per chunk. `dist/` is copied into the
 * shipped Docker image and served to every visitor, and nothing in `bun run
 * check` looked at it. The limit stays where it is — it is vite's own noise
 * control — and the fence is here.
 *
 * ─── What is budgeted, and in which unit ─────────────────────────────
 *
 * Two numbers, each measured in the unit that matters for the thing it fences:
 *
 *   1. CRITICAL PATH, GZIPPED. `dist/index.html` plus every `/assets/*.js` and
 *      `/assets/*.css` it references — the bytes a browser must download before
 *      it can render anything. Gzip because that is what crosses the wire.
 *   2. TOTAL `dist/`, RAW. Every emitted file, uncompressed. Raw because that
 *      is what occupies the Docker image layer.
 *
 * The two catch different regressions and neither implies the other: a lazy
 * chunk that doubles moves (2) and not (1); a `React.lazy` that somebody turns
 * into a static import moves (1) and not (2). Measured 2026-09-08 on this
 * repo's `main`: (1) = 377 747 B gzip over 90 files (index.html + 89 referenced
 * assets), (2) = 17 634 958 B over 310 files.
 *
 * ─── Why NOT a per-chunk budget ──────────────────────────────────────
 *
 * The obvious third shape — a committed size per chunk, checked both
 * directions like `lint-migrations.ts`'s BASELINE — was tried on paper and
 * rejected on the emitted names. Chunk filenames carry a content hash
 * (`react-vendor-D7sx8294.js`), so the key has to be the de-hashed stem, and
 * the de-hashed stems are NOT unique: this build emits seven distinct chunks
 * all called `dist-<hash>.js`, because rolldown names an unnamed chunk after
 * its entry module's directory. A baseline keyed on a name that collides seven
 * ways cannot say which chunk grew. Beyond that, the 89 critical-path names
 * churn with every route rename, so the list would go red on changes that move
 * no bytes — a gate people learn to regenerate without reading, which is the
 * failure mode this branch exists to avoid.
 *
 * ─── The critical-path set is read from the HTML, deliberately widely ─
 *
 * Every `/assets/….{js,css}` string ANYWHERE in `dist/index.html`, not just the
 * ones inside a `<script src>` or `<link href>` tag. That is wider than the
 * tags on purpose: `vite.config.ts`'s `i18nBootPreload` plugin injects the boot
 * locale chunk URLs inside an INLINE SCRIPT (a JSON map keyed by language), so
 * a tag-only scan misses them — measured 2026-09-08: 81 referenced assets and
 * 323 881 B gzip tag-only, versus 89 assets and 377 747 B once the inline map
 * is read (both totals include index.html), i.e. 53 866 B of first-paint weight
 * invisible to the narrow reading.
 *
 * Matching the raw string rather than the plugin's `var m={…}` shape is the
 * point: the number cannot silently shrink because somebody renamed a variable
 * in that inline script. The cost is that both languages' locale chunks are
 * counted while a visitor fetches one (fr 28 401 B gzip, en 25 465 B, measured
 * the same day), so the figure carries ~25 kB no single visitor pays. Erring
 * wide is the right side for a budget, and the alternative — parsing the map to
 * take the worst language — reintroduces exactly the coupling this avoids.
 *
 * ─── Why there is no ratchet-down ────────────────────────────────────
 *
 * The budgets fail only upward. A gate that also failed when the bundle got
 * comfortably SMALLER would go red on the one change everybody wants, and the
 * fix would be to edit the constant — which is how a budget becomes a number
 * people bump without reading. What replaces it is the summary line, which
 * prints the headroom on every run, pass or fail, so the slack is readable
 * without opening this file.
 *
 * Usage: bun scripts/verify-bundle-size.ts   (requires apps/web/dist — the
 *        turbo task depends on `@appstrate/web#build`, which produces it)
 */

import { join } from "node:path";
import { existsSync } from "node:fs";
import { Glob } from "bun";

const REPO_ROOT = join(import.meta.dir, "..");
const DIST_DIR = join(REPO_ROOT, "apps/web/dist");

/**
 * The committed limits.
 *
 * Both were set 2026-09-08 at ~5% above the measured figure, and the slack is
 * stated in bytes rather than left as a percentage because bytes are what a
 * developer compares against the failure message.
 *
 * `criticalPathGzipBytes`: measured 377 747 → 19 253 B of headroom. For scale,
 * the single largest critical-path chunk today is `react-vendor` at 72 660 B
 * gzip and the whole boot locale set for one language is 28 401 B, so this is
 * room for a moderate library, not for a framework.
 *
 * `totalDistBytes`: measured 17 634 958 → 865 042 B of headroom. Dominated by
 * self-hosted monaco (`ts.worker` alone is 6 913 781 B raw), which is why the
 * absolute figure is large and why the percentage, not the byte count, is the
 * meaningful slack here.
 *
 * Raising either is a legitimate change. Raising it without replacing the
 * measurement above it is not: the numbers in this comment are what make the
 * next reader able to tell a justified 30 kB from an accidental one.
 */
export interface BundleBudget {
  criticalPathGzipBytes: number;
  totalDistBytes: number;
}

export const BUDGET: BundleBudget = {
  criticalPathGzipBytes: 397_000,
  totalDistBytes: 18_500_000,
};

/** One emitted file, sized both ways. */
export interface AssetSize {
  /** `dist`-relative, forward slashes. */
  path: string;
  raw: number;
  gzip: number;
}

/** What one measurement pass found. */
export interface BundleMeasurement {
  /** `index.html` plus every asset it references, largest gzip first. */
  criticalFiles: AssetSize[];
  criticalRaw: number;
  criticalGzip: number;
  /** Every file under `dist/`, raw bytes. */
  totalBytes: number;
  totalFiles: number;
}

/**
 * The `dist`-relative paths `index.html` puts on the critical path.
 *
 * Pure and exported so `scripts/test/verify-bundle-size.test.ts` can drive it
 * with the two shapes that matter — a `<script src>`/`<link href>` tag and the
 * inline i18n map — without emitting a real build.
 *
 * Only `/assets/…` is matched: `/favicon.ico`, `/site.webmanifest` and the
 * PNG/SVG icons are referenced from the same head and are neither render
 * blocking nor JS/CSS.
 */
export function criticalPathRefs(html: string): string[] {
  const refs = new Set<string>();
  for (const m of html.matchAll(/\/assets\/[A-Za-z0-9._-]+\.(?:js|css)\b/g)) {
    refs.add(m[0].slice(1));
  }
  return [...refs].sort();
}

/** Human-readable byte count — the failure message is read by people. */
export function formatBytes(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * Size the emitted bundle.
 *
 * Throws rather than reporting a smaller number on every way this can go wrong.
 * A budget gate that measures less than it should is a gate that passes, so
 * "the directory is missing", "the HTML references an asset that is not there"
 * and "the HTML references no JS at all" are all failures of the MEASUREMENT
 * and must not reach the comparison.
 */
export async function measureBundle(distDir: string): Promise<BundleMeasurement> {
  if (!existsSync(distDir)) {
    throw new Error(
      `${distDir} does not exist. This gate sizes the built SPA, so there is nothing to size. ` +
        `Run \`bun run build\` in apps/web (the \`//#verify:bundle-size\` turbo task depends on ` +
        `\`@appstrate/web#build\`, which does it for you).`,
    );
  }

  const htmlPath = join(distDir, "index.html");
  if (!existsSync(htmlPath)) {
    throw new Error(`${htmlPath} does not exist — the build did not emit an entry document.`);
  }

  const htmlBytes = await Bun.file(htmlPath).bytes();
  const criticalFiles: AssetSize[] = [
    { path: "index.html", raw: htmlBytes.length, gzip: Bun.gzipSync(htmlBytes).length },
  ];

  for (const rel of criticalPathRefs(new TextDecoder().decode(htmlBytes))) {
    const abs = join(distDir, rel);
    if (!existsSync(abs)) {
      throw new Error(
        `index.html references \`/${rel}\`, which the build did not emit. Refusing to size a ` +
          `bundle whose entry document points at a missing asset — the total would silently be ` +
          `short by that file.`,
      );
    }
    const bytes = await Bun.file(abs).bytes();
    criticalFiles.push({ path: rel, raw: bytes.length, gzip: Bun.gzipSync(bytes).length });
  }

  if (criticalFiles.length === 1) {
    throw new Error(
      `${htmlPath} references no /assets/*.{js,css} at all — the critical-path budget would be ` +
        `measured over index.html alone and would pass vacuously.`,
    );
  }

  let totalBytes = 0;
  let totalFiles = 0;
  // `dot: true` is load-bearing, not tidiness. Bun's Glob skips dot-prefixed
  // entries by default, and this build emits `dist/.well-known/security.txt`:
  // without the flag the walk returned 309 of the 310 emitted files and a total
  // 228 B short (measured 2026-09-08 against `find dist -type f`). A budget that
  // silently omits part of what ships is a budget with a hole in it, and the
  // hole grows with whatever else lands under a dot directory.
  for await (const rel of new Glob("**/*").scan({ cwd: distDir, onlyFiles: true, dot: true })) {
    totalBytes += (await Bun.file(join(distDir, rel)).stat()).size;
    totalFiles++;
  }
  if (totalFiles === 0) {
    throw new Error(`${distDir} contains no files — the total-size budget would pass vacuously.`);
  }

  criticalFiles.sort((a, b) => b.gzip - a.gzip);
  return {
    criticalFiles,
    criticalRaw: criticalFiles.reduce((n, f) => n + f.raw, 0),
    criticalGzip: criticalFiles.reduce((n, f) => n + f.gzip, 0),
    totalBytes,
    totalFiles,
  };
}

/**
 * Compare a measurement against the budgets. Pure — `main` feeds it a real
 * build, the tests feed it fixtures on both sides of each limit.
 *
 * Each problem names the budget, the measured value, the overshoot in bytes AND
 * percent, and the constant to edit. The overshoot is the part a reader cannot
 * derive from a "too big" message, and it is what tells them whether they added
 * a stray import or a whole library.
 */
export function reviewBudget(m: BundleMeasurement, budget: BundleBudget): string[] {
  const problems: string[] = [];

  if (m.criticalGzip > budget.criticalPathGzipBytes) {
    const over = m.criticalGzip - budget.criticalPathGzipBytes;
    const pct = ((over / budget.criticalPathGzipBytes) * 100).toFixed(1);
    problems.push(
      `critical path is ${formatBytes(m.criticalGzip)} B gzipped across ${m.criticalFiles.length} ` +
        `file(s) — ${formatBytes(over)} B (${pct}%) over the ${formatBytes(budget.criticalPathGzipBytes)} B ` +
        `budget.\n` +
        `    These are the bytes a browser downloads before first render: index.html, the entry ` +
        `chunk, everything it statically imports, the stylesheet and the boot locale chunks.\n` +
        `    Largest contributors (gzip):\n` +
        m.criticalFiles
          .slice(0, 10)
          .map((f) => `      ${formatBytes(f.gzip).padStart(9)} B  ${f.path}`)
          .join("\n") +
        `\n    Fix by moving the new weight behind a dynamic \`import()\` / \`React.lazy\` so it ` +
        `lands in a route chunk. If it genuinely belongs on the critical path, raise ` +
        `BUDGET.criticalPathGzipBytes in scripts/verify-bundle-size.ts and record the new ` +
        `measurement beside it.`,
    );
  }

  if (m.totalBytes > budget.totalDistBytes) {
    const over = m.totalBytes - budget.totalDistBytes;
    const pct = ((over / budget.totalDistBytes) * 100).toFixed(1);
    problems.push(
      `apps/web/dist is ${formatBytes(m.totalBytes)} B across ${m.totalFiles} file(s) — ` +
        `${formatBytes(over)} B (${pct}%) over the ${formatBytes(budget.totalDistBytes)} B budget.\n` +
        `    This whole directory is copied into the shipped Docker image.\n` +
        `    Fix by dropping the dependency that grew it, or raise BUDGET.totalDistBytes in ` +
        `scripts/verify-bundle-size.ts and record the new measurement beside it.`,
    );
  }

  return problems;
}

/**
 * The one-line verdict, with the counts that distinguish it from a no-op run
 * and the headroom that keeps the budgets readable without opening this file.
 */
export function summaryLine(m: BundleMeasurement, budget: BundleBudget): string {
  const critPct = ((m.criticalGzip / budget.criticalPathGzipBytes) * 100).toFixed(1);
  const totalPct = ((m.totalBytes / budget.totalDistBytes) * 100).toFixed(1);
  return (
    `${m.totalFiles} emitted file(s) — critical path ${formatBytes(m.criticalGzip)} B gzip over ` +
    `${m.criticalFiles.length} file(s) (${critPct}% of ${formatBytes(budget.criticalPathGzipBytes)} B, ` +
    `${formatBytes(budget.criticalPathGzipBytes - m.criticalGzip)} B headroom); ` +
    `total ${formatBytes(m.totalBytes)} B raw (${totalPct}% of ${formatBytes(budget.totalDistBytes)} B, ` +
    `${formatBytes(budget.totalDistBytes - m.totalBytes)} B headroom).`
  );
}

// Guarded so `scripts/test/verify-bundle-size.test.ts` can drive the pure
// reviewers and the measurement against fixture directories without needing a
// real SPA build — same pattern as `lint-migrations.ts`.
if (import.meta.main) {
  const measurement = await measureBundle(DIST_DIR);
  const problems = reviewBudget(measurement, BUDGET);

  for (const p of problems) console.error(`❌ ${p}`);

  if (problems.length === 0) {
    console.log(`✅ bundle size within budget — ${summaryLine(measurement, BUDGET)}`);
    process.exit(0);
  }

  console.error(`\n❌ bundle size over budget — ${summaryLine(measurement, BUDGET)}`);
  process.exit(1);
}
