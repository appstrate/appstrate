#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * 0007 — quote the skill `description:` lines that `yaml` cannot parse.
 *
 *   bun scripts/migration/0007-skill-frontmatter-quote-descriptions.ts [--apply]
 *
 * Run AFTER deploying the SKILL.md frontmatter gate, against production.
 *
 * Why this exists: the platform now refuses to WRITE a skill whose SKILL.md
 * frontmatter `yaml` cannot read (`checkSkillMarkdown`,
 * `@appstrate/afps-shared/companion-files`). Measured on production at the time
 * of writing, over 66 skill packages:
 *
 *   17  `description: … : …` — an unquoted colon-space inside a plain scalar.
 *       `yaml` refuses it ("Nested mappings are not allowed in compact
 *       mappings") and so does Pi 0.84.2 (`dist/core/skills.js`
 *       `loadSkillFromFile` throws and returns `skill: null`), so these skills
 *       are ALREADY degraded at run time — the agent never loads them.
 *    2  a `name` with spaces or uppercase — not fixable mechanically.
 *    1  a description of 1335 characters — not fixable mechanically.
 *
 * They still LOAD through the platform's lenient `checkCompanionFiles` probe,
 * which is why that probe stays lenient (`companion-files.ts`) — but their
 * drafts can no longer be saved or published. This script quotes the 17 so they
 * are writable again, and reports the other 3 for a human to edit.
 *
 * The fix is deliberately narrow. It rewrites ONE line — `description:` — as a
 * YAML scalar that needs NO escaping: single-quoted when the text contains no
 * `'`, otherwise a literal block scalar (`|-`). Nothing inside either form is
 * interpreted, so the bytes between the delimiters are the author's own; four
 * of these descriptions contain a `"`, which any escaping scheme would rewrite.
 *
 * It applies only when BOTH hold afterwards:
 *
 *   a) `checkSkillMarkdown` now passes, and
 *   b) the `name` and `description` the platform will READ after the fix
 *      (`parseSkillFrontmatter` — what `extractSkillMeta` now returns) equal
 *      what it believed BEFORE (the pre-gate lenient reader, reproduced
 *      verbatim below). Nothing the platform knows about the skill changes.
 *
 * Anything else is reported as "needs manual edit" and left untouched.
 *
 * Both copies the PUT handler keeps in step are written, through the same two
 * calls that handler makes (`updateOrgItem` then `uploadPackageFiles`), so the
 * `packages.draft_content` column and the stored `SKILL.md` cannot diverge.
 * `package_versions` and published artifacts are NEVER touched: they are
 * immutable, and the run launcher's lenient loader keeps serving them.
 *
 * System packages are excluded by `org_id IS NOT NULL` — they carry no org and
 * are re-synced from `system-packages/` at boot. Ephemeral rows are excluded
 * too (chat scratch packages, compacted away).
 *
 * Idempotent: a second run finds every fixed row conforming and reports 0
 * changes. Dry-run by default; `--apply` writes.
 *
 * NOT one transaction — the two sinks are a DB row and an object store, which
 * no transaction spans, so this script is per-package and resumable instead:
 * a crash between the row write and the upload leaves that package with a
 * conforming `draft_content` and a stale stored file, and the next run fixes
 * the stored file alone. A package whose read or write THROWS is reported as
 * FAILED and the pass continues; the exit code is non-zero when any did.
 *
 * Rows: UNMEASURED against a restored dump at the time of writing — the counts
 * above come from reading production's `packages` rows, not from a rehearsal.
 * Rehearse against a `pg_dump` restore before `--apply`, per
 * `scripts/migration/README.md`.
 *
 * Verify (before, and again after — the second run must print 0):
 *
 *   bun scripts/migration/0007-skill-frontmatter-quote-descriptions.ts
 */

import { parseArgs } from "node:util";
import { db } from "@appstrate/db/client";
import { packages } from "@appstrate/db/schema";
import {
  checkSkillMarkdown,
  decodeSkillMarkdown,
  parseSkillFrontmatter,
} from "@appstrate/afps-shared/companion-files";
import { updateOrgItem } from "../../apps/api/src/services/package-items/crud.ts";
import {
  downloadPackageFiles,
  uploadPackageFiles,
} from "../../apps/api/src/services/package-items/storage.ts";
import { storageFolderForType } from "../../apps/api/src/services/package-items/config.ts";
import { getErrorMessage } from "@appstrate/core/errors";

/** The frontmatter block reader `extractSkillMeta` used before the gate landed. */
const FRONTMATTER_RE = /^---[^\S\n]*\n([\s\S]*?)\n---/;
const DESCRIPTION_LINE_RE = /^description:[ \t]*(.+)$/m;
const NAME_LINE_RE = /^name:[ \t]*(.+)$/m;

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * `extractSkillMeta`'s reader as it was on main, reproduced so the rewrite can
 * be proven not to change what the platform already believes.
 */
export function lenientSkillMeta(content: string): { name: string; description: string } {
  const fm = FRONTMATTER_RE.exec(content)?.[1];
  if (fm === undefined) return { name: "", description: "" };
  const nameMatch = NAME_LINE_RE.exec(fm);
  const descMatch = DESCRIPTION_LINE_RE.exec(fm);
  return {
    name: nameMatch ? stripQuotes(nameMatch[1]!) : "",
    description: descMatch ? stripQuotes(descMatch[1]!) : "",
  };
}

/**
 * Rewrite the frontmatter's `description:` line as a scalar that needs no
 * escaping, or `null` when there is no block or no such line.
 *
 * Single-quoted holds `"`, `\` and `#` literally; the one character it cannot
 * hold without doubling is `'`, so a text containing one goes into a literal
 * block scalar instead, where nothing at all is interpreted. The value is a
 * single line either way (the reader it comes from reads one line), so `|-`
 * emits exactly it, with no trailing newline.
 */
export function quoteDescriptionLine(content: string): string | null {
  const block = FRONTMATTER_RE.exec(content);
  const fm = block?.[1];
  if (block === null || fm === undefined) return null;
  const line = DESCRIPTION_LINE_RE.exec(fm);
  if (line === null) return null;

  const value = stripQuotes(line[1]!);
  const quoted = value.includes("'") ? `description: |-\n  ${value}` : `description: '${value}'`;
  const rewrittenBlock = fm.slice(0, line.index) + quoted + fm.slice(line.index + line[0].length);
  const start = block.index + block[0].indexOf(fm);
  return content.slice(0, start) + rewrittenBlock + content.slice(start + fm.length);
}

export type FixPlan =
  | { outcome: "conforming" }
  | { outcome: "fixed"; content: string }
  | { outcome: "manual"; reason: string };

/** Decide what to do with one SKILL.md. Pure — this is what the tests drive. */
export function planFix(content: string): FixPlan {
  const violation = checkSkillMarkdown(content);
  if (violation === null) return { outcome: "conforming" };
  if (violation.reason !== "SKILL_INVALID_FRONTMATTER") {
    return { outcome: "manual", reason: violation.reason.toLowerCase() };
  }

  const rewritten = quoteDescriptionLine(content);
  if (rewritten === null) return { outcome: "manual", reason: "no description line to quote" };

  const after = checkSkillMarkdown(rewritten);
  if (after !== null) return { outcome: "manual", reason: after.reason.toLowerCase() };

  // What the platform will read now vs what it believed before.
  const before = lenientSkillMeta(content);
  const now = parseSkillFrontmatter(rewritten);
  if (before.name !== now.name || before.description !== now.description) {
    return { outcome: "manual", reason: "the fix would change the stored name/description" };
  }
  return { outcome: "fixed", content: rewritten };
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

interface SkillRow {
  id: string;
  orgId: string | null;
  lockVersion: number;
  draftManifest: unknown;
  draftContent: string | null;
}

type RowOutcome =
  | { kind: "conforming" }
  | { kind: "fixed" }
  | { kind: "manual"; message: string }
  | { kind: "failed"; message: string };

async function processRow(
  row: SkillRow,
  folder: ReturnType<typeof storageFolderForType>,
  apply: boolean,
): Promise<RowOutcome> {
  const orgId = row.orgId!;
  const storedFiles = await downloadPackageFiles(folder, orgId, row.id);
  const storedBytes = storedFiles?.["SKILL.md"];
  const stored = storedBytes ? decodeSkillMarkdown(storedBytes) : null;
  const draft = row.draftContent;

  // Both copies are the same string for a skill (the PUT handler writes one
  // value to both), but they are planned independently so a drifted row is
  // never "fixed" by copying one over the other.
  const plans = [
    { label: "stored SKILL.md", plan: stored === null ? null : planFix(stored) },
    { label: "draft_content", plan: draft === null ? null : planFix(draft) },
  ];

  const blocked = plans.find((p) => p.plan?.outcome === "manual");
  if (blocked) {
    const plan = blocked.plan as { outcome: "manual"; reason: string };
    return { kind: "manual", message: `${blocked.label}: ${plan.reason}` };
  }
  if (!plans.some((p) => p.plan?.outcome === "fixed")) return { kind: "conforming" };

  const newDraft = plans[1]!.plan?.outcome === "fixed" ? plans[1]!.plan.content : (draft ?? "");
  const newStored = plans[0]!.plan?.outcome === "fixed" ? plans[0]!.plan.content : stored;

  if (!apply) return { kind: "fixed" };

  // Same two writes, in the same order, as `makeUpdateHandler`.
  const updated = await updateOrgItem(
    orgId,
    row.id,
    { manifest: (row.draftManifest ?? {}) as Record<string, unknown>, content: newDraft },
    row.lockVersion,
  );
  if (!updated) {
    return {
      kind: "failed",
      message: `lock_version ${row.lockVersion} was stale (concurrent edit)`,
    };
  }
  if (newStored !== null && storedFiles) {
    await uploadPackageFiles(folder, orgId, row.id, {
      ...storedFiles,
      "SKILL.md": new TextEncoder().encode(newStored),
    });
  }
  return { kind: "fixed" };
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { apply: { type: "boolean" }, help: { type: "boolean", short: "h" } },
    strict: true,
  });

  if (values.help === true) {
    out("Usage: bun scripts/migration/0007-skill-frontmatter-quote-descriptions.ts [--apply]");
    out("  Quotes skill SKILL.md `description:` lines that yaml cannot parse.");
    out("  Default: dry-run (report only). --apply: write draft_content + stored SKILL.md.");
    return 0;
  }
  const apply = values.apply === true;

  // Selected whole and filtered here rather than in SQL: `drizzle-orm` does not
  // resolve from the repo root (only from the workspaces that depend on it),
  // and `packages` is a few hundred rows on the largest deployment.
  const all = await db
    .select({
      id: packages.id,
      type: packages.type,
      ephemeral: packages.ephemeral,
      orgId: packages.orgId,
      lockVersion: packages.lockVersion,
      draftManifest: packages.draftManifest,
      draftContent: packages.draftContent,
    })
    .from(packages);
  const rows = all.filter((r) => r.type === "skill" && !r.ephemeral && r.orgId !== null);

  let fixed = 0;
  let conforming = 0;
  let manual = 0;
  let failed = 0;
  const folder = storageFolderForType("skill");

  for (const row of rows) {
    let outcome: RowOutcome;
    try {
      outcome = await processRow(row as SkillRow, folder, apply);
    } catch (err) {
      // One package's storage read, row write or upload failing must not abort
      // the pass — the rows already written stay written, and a re-run picks up
      // where this one left off.
      outcome = { kind: "failed", message: getErrorMessage(err) };
    }
    if (outcome.kind === "conforming") {
      conforming += 1;
    } else if (outcome.kind === "manual") {
      out(`needs manual edit: ${row.id} — ${outcome.message}`);
      manual += 1;
    } else if (outcome.kind === "failed") {
      out(`FAILED: ${row.id} — ${outcome.message}`);
      failed += 1;
    } else {
      out(`fixed${apply ? "" : " (dry-run)"}: ${row.id}`);
      fixed += 1;
    }
  }

  out("");
  out(`skills scanned: ${rows.length}`);
  out(`  fixed: ${fixed}${apply ? "" : " (dry-run — re-run with --apply to write)"}`);
  out(`  skipped (conforming): ${conforming}`);
  out(`  needs manual edit: ${manual}`);
  if (failed > 0) out(`  FAILED: ${failed}`);
  return failed > 0 ? 1 : 0;
}

// Guarded so the tests can import the pure functions without touching the database.
if (import.meta.main) {
  process.exit(await main());
}
