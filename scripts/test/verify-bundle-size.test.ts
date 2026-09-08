// SPDX-License-Identifier: Apache-2.0

/**
 * The SPA bundle budget, on both sides of each limit and on every way the
 * MEASUREMENT can be wrong.
 *
 * The second half is the one worth having. A budget gate fails open: anything
 * that makes it size LESS than the build actually emits — a missing directory,
 * an asset the HTML names but the build did not write, a walk that skips dot
 * directories — reads as a smaller bundle and a passing check. So every one of
 * those is asserted to THROW here, not to be tolerated.
 *
 * The dot-directory case is not hypothetical: `Bun.Glob("**\/*")` skips
 * dot-prefixed entries by default, this build emits
 * `dist/.well-known/security.txt`, and the first version of `measureBundle`
 * reported 309 of 310 files.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUDGET,
  criticalPathRefs,
  measureBundle,
  reviewBudget,
  summaryLine,
  type BundleMeasurement,
} from "../verify-bundle-size.ts";

/** A measurement fixture — the reviewers only read the five totals. */
function measurement(over: Partial<BundleMeasurement> = {}): BundleMeasurement {
  return {
    criticalFiles: [
      { path: "assets/react-vendor-AAAAAAAA.js", raw: 229_005, gzip: 72_660 },
      { path: "index.html", raw: 8_345, gzip: 2_206 },
    ],
    criticalRaw: 237_350,
    criticalGzip: 74_866,
    totalBytes: 1_000_000,
    totalFiles: 42,
    ...over,
  };
}

describe("criticalPathRefs", () => {
  it("finds an asset referenced by a tag", () => {
    expect(
      criticalPathRefs(
        `<script type="module" crossorigin src="/assets/index-CXmm9Fkl.js"></script>` +
          `<link rel="stylesheet" href="/assets/index-C79KYxBy.css">`,
      ),
    ).toEqual(["assets/index-CXmm9Fkl.js", "assets/index-C79KYxBy.css"].sort());
  });

  it("finds an asset referenced ONLY from the inline i18n boot map", () => {
    // The negative control for the case above, and the reason the scan matches
    // raw strings rather than tags: `vite.config.ts`'s i18nBootPreload plugin
    // emits these URLs inside a `<script>` body, so a tag-driven scan sizes a
    // bundle 53 866 B lighter than the one a browser fetches.
    expect(
      criticalPathRefs(
        `<script>(function(){var m={"fr":["/assets/agents-zgsn41AX.js"]},f="fr";})();</script>`,
      ),
    ).toEqual(["assets/agents-zgsn41AX.js"]);
  });

  it("ignores the non-JS/CSS assets in the same head", () => {
    expect(
      criticalPathRefs(
        `<link rel="icon" href="/favicon.ico">` +
          `<link rel="manifest" href="/site.webmanifest">` +
          `<link rel="apple-touch-icon" href="/apple-touch-icon.png">` +
          `<link rel="preload" href="/assets/codicon-Brq4_Ui5.ttf" as="font">`,
      ),
    ).toEqual([]);
  });

  it("counts a repeated reference once", () => {
    const html = `<script src="/assets/a-1.js"></script><link href="/assets/a-1.js">`;
    expect(criticalPathRefs(html)).toEqual(["assets/a-1.js"]);
  });
});

describe("reviewBudget", () => {
  it("passes when both figures are under budget", () => {
    expect(reviewBudget(measurement(), BUDGET)).toEqual([]);
  });

  it("passes at exactly the limit", () => {
    // The boundary, asserted rather than assumed: the comparison is `>`, so a
    // build landing precisely on the number is not a regression.
    const problems = reviewBudget(
      measurement({
        criticalGzip: BUDGET.criticalPathGzipBytes,
        totalBytes: BUDGET.totalDistBytes,
      }),
      BUDGET,
    );
    expect(problems).toEqual([]);
  });

  it("fails one byte over the critical-path limit, naming the delta", () => {
    const problems = reviewBudget(
      measurement({ criticalGzip: BUDGET.criticalPathGzipBytes + 1 }),
      BUDGET,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("1 B (0.0%) over");
    expect(problems[0]).toContain("397,000 B budget");
    // "what grew" has to be readable from the message, or the budget just gets
    // raised: the largest contributors are listed.
    expect(problems[0]).toContain("assets/react-vendor-AAAAAAAA.js");
    expect(problems[0]).toContain("BUDGET.criticalPathGzipBytes");
  });

  it("fails over the total-dist limit independently of the critical path", () => {
    // The two budgets catch different regressions; a lazy chunk that doubles
    // moves only this one.
    const problems = reviewBudget(measurement({ totalBytes: 20_000_000 }), BUDGET);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("apps/web/dist is 20,000,000 B");
    expect(problems[0]).toContain("1,500,000 B (8.1%) over");
    expect(problems[0]).toContain("BUDGET.totalDistBytes");
  });

  it("reports both when both are over", () => {
    expect(
      reviewBudget(measurement({ criticalGzip: 500_000, totalBytes: 20_000_000 }), BUDGET),
    ).toHaveLength(2);
  });
});

describe("summaryLine", () => {
  it("prints the counts and the remaining headroom", () => {
    // A gate that prints "OK" without a count cannot be told apart from a gate
    // that inspected nothing — and headroom nobody can read gets raised.
    const line = summaryLine(measurement(), BUDGET);
    expect(line).toContain("42 emitted file(s)");
    expect(line).toContain("critical path 74,866 B gzip over 2 file(s)");
    expect(line).toContain("322,134 B headroom");
    expect(line).toContain("17,500,000 B headroom");
  });
});

describe("measureBundle", () => {
  let dist: string;

  beforeAll(() => {
    dist = mkdtempSync(join(tmpdir(), "appstrate-bundle-"));
  });

  afterAll(() => {
    rmSync(dist, { recursive: true, force: true });
  });

  /** Lay out a synthetic `dist/` and return its path. */
  function build(name: string, files: Record<string, string>): string {
    const root = join(dist, name);
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(root, rel);
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, content);
    }
    return root;
  }

  it("sizes the critical path and the whole directory", async () => {
    const root = build("ok", {
      "index.html": `<script src="/assets/app-A.js"></script>`,
      "assets/app-A.js": "x".repeat(1000),
      "assets/lazy-B.js": "y".repeat(5000),
    });
    const m = await measureBundle(root);

    expect(m.totalFiles).toBe(3);
    expect(m.criticalFiles.map((f) => f.path).sort()).toEqual(["assets/app-A.js", "index.html"]);
    // The lazy chunk is in the total and NOT on the critical path — the whole
    // reason there are two numbers.
    expect(m.totalBytes).toBe(6000 + m.criticalFiles.find((f) => f.path === "index.html")!.raw);
    expect(m.criticalRaw).toBeLessThan(m.totalBytes);
    // 1 000 repeated bytes compress; the gzip figure must be the compressed one.
    expect(m.criticalGzip).toBeLessThan(m.criticalRaw);
  });

  it("counts files under a dot directory", async () => {
    // Bun's Glob skips dotfiles unless `dot: true`. Without it this build
    // reported 309 of its 310 real files and a total 228 B short.
    const root = build("dotdir", {
      "index.html": `<script src="/assets/app-A.js"></script>`,
      "assets/app-A.js": "x".repeat(10),
      ".well-known/security.txt": "contact: security@example.test\n",
    });
    expect((await measureBundle(root)).totalFiles).toBe(3);
  });

  it("throws when the dist directory is absent", async () => {
    await expect(measureBundle(join(dist, "never-built"))).rejects.toThrow(/does not exist/);
  });

  it("throws when index.html is absent", async () => {
    const root = build("no-html", { "assets/app-A.js": "x" });
    await expect(measureBundle(root)).rejects.toThrow(/did not emit an entry document/);
  });

  it("throws when index.html names an asset the build did not emit", async () => {
    // Silently skipping it would under-count the critical path by exactly the
    // file that went missing, and print a tick.
    const root = build("missing-asset", {
      "index.html": `<script src="/assets/gone-Z.js"></script>`,
      "assets/app-A.js": "x",
    });
    await expect(measureBundle(root)).rejects.toThrow(/which the build did not emit/);
  });

  it("throws when index.html references no JS or CSS at all", async () => {
    const root = build("vacuous", { "index.html": `<link rel="icon" href="/favicon.ico">` });
    await expect(measureBundle(root)).rejects.toThrow(/pass vacuously/);
  });
});

describe("BUDGET", () => {
  it("keeps both limits positive and the critical path inside the total", () => {
    // A transposed edit (gzip limit above the raw-total limit) would make the
    // critical-path budget unreachable and the gate decorative.
    expect(BUDGET.criticalPathGzipBytes).toBeGreaterThan(0);
    expect(BUDGET.criticalPathGzipBytes).toBeLessThan(BUDGET.totalDistBytes);
  });
});
