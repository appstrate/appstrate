// SPDX-License-Identifier: Apache-2.0
/// <reference types="bun" />

/**
 * Gate — data repair must not live in a drizzle migration.
 *
 * The rule this enforces, and every reason behind it, is stated once — in
 * `docs/NO_TRANSITIONAL_CODE.md` §2, which is the authority. Read it there.
 * This header describes the implementation only.
 *
 * What the code does: reject every `UPDATE` / `INSERT` / `DELETE` / `TRUNCATE`
 * that opens a statement in a new migration, UNLESS it is an `UPDATE` and the
 * same file also carries one of the four clauses §2 licences ON THAT TABLE —
 * `SET NOT NULL`, `CHECK`, `VALIDATE CONSTRAINT` (the three constraint
 * preconditions) or `DROP COLUMN` (the fold whose source the file destroys).
 * Same table, not merely the same file: see `licencedTables`, which also
 * records the one hole this deliberately leaves open. Only an `UPDATE` is ever
 * licenceable — see `LICENCEABLE` — and a `CHECK` added `NOT VALID` licences
 * nothing, see `isDeferredCheck`.
 *
 * Only NEW files are gated. Every migration already in the directory has run
 * on real databases and cannot be changed, so the eight that predate this rule
 * are listed in `GRANDFATHERED` below — explicitly, so the exemption is
 * reviewable rather than implicit, and checked against the directory so an
 * entry cannot go on excusing a name nothing occupies.
 */

import { basename, join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";

const REPO_ROOT = join(import.meta.dir, "..");
const MIGRATIONS_DIR = join(REPO_ROOT, "packages/db/drizzle");

/**
 * Migrations that carry data repair and predate this gate.
 *
 * Membership means one thing, and it is a historical fact rather than a
 * verdict: the file carries data repair AND it predates this gate. Both halves
 * are permanent — a drizzle migration is never edited after it ships — so an
 * entry is never re-litigated when the carve-out moves. The list may shrink
 * only when a file leaves the directory, and it may never grow: a ninth entry
 * means a NEW migration slipped the gate, not that the list was short.
 *
 * Deliberately NOT "files the current rules would flag". Whether §2's
 * carve-out happens to licence one of these is incidental and changes with the
 * regex; the fact that it shipped before there was a gate does not. Pruning an
 * entry the carve-out currently covers would silently convert a permanently
 * exempt file into a conditionally exempt one, so that the next tightening of
 * `LICENCE` — which §2 explicitly anticipates, see `licencedTables`'s
 * column-level limit — would re-flag an immutable file with no lawful remedy,
 * since the only fix would be to grow this list.
 *
 * The set was established by READING every file in the directory, then
 * confirmed against an independent scan for DML-shaped statements; that scan
 * found row rewrites in twelve files, of which `0021`, `0029`, `0038` and
 * `0051` are genuine constraint preconditions on the very table they repair.
 *
 * Two entries are already no-ops under today's carve-out and stay listed for
 * exactly the reason above. `0018_white_captain_universe`'s `runs` fold is
 * licenced by the `DROP COLUMN "version_dirty"` on the next line;
 * `0023_attribution_llm_usage` is exempted more weakly still, by the
 * table-level limit rather than by any rule, since its `CHECK` covers columns
 * its backfill never touches. Narrow the carve-out to columns and `0023` goes
 * live again; narrow it further and `0018` follows. `0040_config_into_input`
 * is listed on its own merits — two of its three folds are licenced, but its
 * `application_packages` wrap keeps a surviving column and is a real finding.
 */
export const GRANDFATHERED: readonly string[] = [
  "0018_white_captain_universe",
  "0022_prune_cross_org_application_packages",
  "0023_attribution_llm_usage",
  "0030_null_static_provider_available_models",
  "0033_green_jimmy_woo",
  "0040_config_into_input",
  "0044_finish_file_rename",
  "0046_legacy_permission_scope_strings",
];

/**
 * Blank out everything SQL does not execute, keeping every byte offset.
 *
 * Comments and string literals are replaced by spaces (newlines survive, so
 * line numbers stay true) rather than deleted, because a migration header
 * discussing `UPDATE` in prose is the common case here — `0051` alone mentions
 * all three keywords in its comment block — and a literal `'... DELETE ...'`
 * is not a statement either.
 *
 * Dollar-quoted bodies (`$$ … $$`) are deliberately NOT blanked: a `DO $$ …
 * INSERT … END $$` block is exactly the shape this gate must still see.
 *
 * `--> statement-breakpoint` is drizzle's separator and is itself a comment.
 * It becomes a `;` (same width) so it keeps acting as a boundary once the
 * comment stripping below would otherwise erase it.
 */
export function sanitize(sql: string): string {
  const BREAKPOINT = "--> statement-breakpoint";
  const source = sql.replaceAll(BREAKPOINT, ";".padEnd(BREAKPOINT.length));

  let out = "";
  let i = 0;
  const keep = (n: number): void => {
    out += source.slice(i, i + n);
    i += n;
  };
  const blank = (n: number): void => {
    for (const ch of source.slice(i, i + n)) out += ch === "\n" ? "\n" : " ";
    i += n;
  };

  while (i < source.length) {
    const rest = source.slice(i);
    if (rest.startsWith("--")) {
      const end = source.indexOf("\n", i);
      blank((end === -1 ? source.length : end) - i);
    } else if (rest.startsWith("/*")) {
      const end = source.indexOf("*/", i + 2);
      blank((end === -1 ? source.length : end + 2) - i);
    } else if (rest.startsWith("'")) {
      // `''` is an escaped quote, not a terminator.
      let end = i + 1;
      while (end < source.length) {
        if (source[end] !== "'") end += 1;
        else if (source[end + 1] === "'") end += 2;
        else break;
      }
      blank(Math.min(end + 1, source.length) - i);
    } else {
      keep(1);
    }
  }
  return out;
}

/**
 * Does a DML keyword at `index` open a statement, or is it part of a clause?
 *
 * `ON DELETE CASCADE`, `ON UPDATE NO ACTION` and `ON CONFLICT DO UPDATE` are
 * everywhere in this directory — matching the bare word would flag every
 * foreign key in `0000_init`. So the token before it must be a boundary:
 *
 *   - nothing, or `;` (which `--> statement-breakpoint` became);
 *   - `$`, the `$$` opening a `DO` body;
 *   - a PL/pgSQL keyword a nested statement can follow (`STATEMENT_OPENERS`);
 *   - `)`, which closes the last CTE of a `WITH … AS (…) UPDATE …`;
 *   - `(`, which opens a CTE body holding the DML itself, as in
 *     `WITH moved AS (DELETE FROM a RETURNING *) INSERT INTO b SELECT …`.
 *
 * The last two are not decoration. `WITH … AS (DELETE … RETURNING *) INSERT
 * INTO other …` is THE idiomatic Postgres way to move rows between tables —
 * exactly a `scripts/migration/` job — and without them the whole form passed
 * this gate in silence: the keyword after `)` and the one after `(` were both
 * read as mid-clause.
 *
 * `,` is deliberately NOT a boundary. It would admit the second half of a
 * privilege list (`GRANT INSERT, UPDATE ON …`), which grants a right rather
 * than writing a row, and no CTE needs it: a DML inside `WITH a AS (…), b AS
 * (DELETE …)` still sits directly behind that body's `(`.
 */
const STATEMENT_OPENERS = new Set(["BEGIN", "THEN", "ELSE", "LOOP"]);
const BOUNDARY_CHARS = [";", "$", "(", ")"];

function startsStatement(sanitized: string, index: number): boolean {
  const before = sanitized.slice(0, index).trimEnd();
  if (before === "") return true;
  if (BOUNDARY_CHARS.some((c) => before.endsWith(c))) return true;
  const lastWord = /([A-Za-z_]+)$/.exec(before)?.[1];
  return lastWord !== undefined && STATEMENT_OPENERS.has(lastWord.toUpperCase());
}

/**
 * The write vocabulary.
 *
 * `TRUNCATE` is in it because it removes every row in a table, which is the
 * most total row rewrite there is — and it was invisible to the first version
 * of this gate. See `LICENCEABLE` for why it never reaches the carve-out.
 */
const DML = /\b(UPDATE|INSERT|DELETE|TRUNCATE)\b/gi;

/**
 * The ONLY write the same-table carve-out can licence.
 *
 * Both shapes §2 exempts are `UPDATE`s and nothing else: a backfill fills the
 * column a constraint is about to require, and a fold copies a column's values
 * somewhere else before the file drops it. Neither is expressible as an
 * `INSERT`, a `DELETE` or a `TRUNCATE`, so no licence clause may excuse one.
 *
 * Stated as a whitelist rather than a `TRUNCATE` blacklist deliberately. The
 * blacklist was the same rule for the destructive case, but only for that one
 * case: `DELETE FROM t;` empties a table exactly as `TRUNCATE t;` does, and it
 * sailed through any file that also carried a licence clause on `t`. Licencing
 * is now closed by default and opened for one verb, so a fourth DML verb added
 * to the vocabulary later cannot inherit an exemption nobody argued for.
 *
 * This is also why `dmlTarget` never parses a `TRUNCATE`, and why its
 * comma-separated form (`TRUNCATE a, b, c`) needs no handling: with no
 * exemption available there is no target to match against, and every table in
 * the list is reported through the statement text either way.
 */
const LICENCEABLE = /^UPDATE$/i;

/**
 * A possibly schema-qualified SQL identifier: `x`, `"x"`, `public.x`,
 * `"public"."x"`.
 */
const IDENT = String.raw`(?:"[^"]*"|[A-Za-z_][A-Za-z0-9_$]*)`;
const QUALIFIED = `${IDENT}(?:\\s*\\.\\s*${IDENT})*`;

/** The bare table name, unquoted and lowercased, for comparison. */
function normalizeTable(raw: string): string {
  const parts = raw.match(new RegExp(IDENT, "g")) ?? [];
  return (parts.at(-1) ?? raw).replaceAll('"', "").toLowerCase();
}

/** The table a DML statement writes to, or `null` if it cannot be read. */
function dmlTarget(sanitized: string, index: number): string | null {
  const head = new RegExp(
    `^(?:UPDATE|DELETE\\s+FROM|INSERT\\s+INTO)\\s+(?:ONLY\\s+)?(${QUALIFIED})`,
    "i",
  ).exec(sanitized.slice(index));
  return head?.[1] === undefined ? null : normalizeTable(head[1]);
}

/**
 * The statement a constraint clause belongs to: `ALTER TABLE x …` /
 * `CREATE TABLE x …`. Scanned so each licence below can be attributed to the
 * table it actually lands on.
 */
const TABLE_STATEMENT = `\\b(?:ALTER|CREATE)\\s+TABLE\\s+(?:IF\\s+(?:NOT\\s+)?EXISTS\\s+)?(?:ONLY\\s+)?(${QUALIFIED})`;

/**
 * The four clauses `docs/NO_TRANSITIONAL_CODE.md` §2 licences a write beside.
 *
 * Three are constraint preconditions — `SET NOT NULL`, `CHECK`,
 * `VALIDATE CONSTRAINT`. The `VALIDATE` is matched on its own, never paired
 * with an `ADD CONSTRAINT`, and that is §2's wording, not a shortcut: the safe
 * pattern on a large table adds the constraint `NOT VALID` in one file and
 * repairs-then-validates in a later one (`0020`/`0021`), so requiring the
 * `ADD` here would reject the very shape the docs recommend.
 *
 * The fourth is `DROP COLUMN`, which licences a fold: after the `DROP` the
 * source values are gone, so the write cannot be deferred to an operator
 * script. Its bound is the `DROP` itself — a file that keeps every column
 * licences nothing, which is why `0033`'s `metadata` strip is still a finding.
 *
 * `SET NOT NULL` and not a bare `NOT NULL`, which is the narrowing §2 already
 * states — only a *promotion* counts. A `NOT NULL` in a column DEFINITION is
 * not a promotion — Postgres refuses `ADD COLUMN … NOT NULL` on a populated
 * table without a `DEFAULT`, and that default already satisfies the
 * constraint, so no backfill was ever its precondition. It also drops the
 * `IS NOT NULL` problem for free: a `WHERE` predicate cannot match this shape
 * at all.
 */
const LICENCE = new RegExp(
  [
    String.raw`\bSET\s+NOT\s+NULL\b`,
    // `ADD CONSTRAINT <name> CHECK (`, never a bare `CHECK (`. A `CHECK` in a
    // COLUMN DEFINITION (`ADD COLUMN c int CHECK (…)`, or one inside a
    // `CREATE TABLE`) is the same non-event as a `NOT NULL` in a column
    // definition, and is excluded for the same reason stated above: the column
    // is new, so every existing row satisfies it vacuously and no backfill was
    // ever its precondition. Leaving it wide made the `isDeferredCheck` rule
    // below bypassable by moving the constraint inline.
    String.raw`\bADD\s+CONSTRAINT\s+(?:"[^"]*"|[A-Za-z_][A-Za-z0-9_$]*)\s+CHECK\s*\(`,
    String.raw`\bVALIDATE\s+CONSTRAINT\b`,
    String.raw`\bDROP\s+COLUMN\b`,
  ].join("|"),
  "gi",
);

/**
 * Every table this file carries a `LICENCE` clause for.
 *
 * Same-TABLE, not file-level, and that is the whole of the carve-out's
 * strength. File-level, any unrelated `SET NOT NULL`, `CHECK` or `DROP COLUMN`
 * anywhere in the file licences any data repair anywhere else in it — a bypass
 * a future author reaches by accident, not by intent: add a constrained column
 * to table A, fold some rows on table B, gate green. `0018` is exactly that
 * shape (its `CHECK` lands on `package_schedules`, its `UPDATE` on `runs`, and
 * only the `DROP COLUMN "version_dirty"` on `runs` legitimately licences it).
 *
 * ─── What this does NOT catch ───────────────────────────────────────
 *
 * A licensing clause and an unrelated data repair on the SAME table. `0023` is
 * the live example: it adds `CHECK (run_id IS NULL OR chat_session_id IS NULL)`
 * to `llm_usage` and, in the same file, backfills `llm_usage.credential_source`
 * — a different column, and plain data repair. Structurally it is
 * indistinguishable from `0038`, where the `CHECK` covers the very column the
 * `UPDATE` fills and the backfill genuinely is the precondition. `DROP COLUMN`
 * has the identical reach: it licences the fold of the column it drops, and
 * cannot see that a second write touches a column the file keeps.
 *
 * Telling those two apart needs column-level analysis — resolving which
 * columns a CHECK expression reads, which ones a DROP removes, and which ones
 * an UPDATE assigns — and that is deliberately out of scope for a lint script.
 * The gate stops at the table boundary, and says so here rather than implying
 * a reach it does not have.
 *
 * Two writing forms are also outside the `DML` vocabulary, on purpose:
 *
 *   - `SELECT … INTO t FROM …` — inside a `DO $$` body, which this gate
 *     deliberately reads, `SELECT … INTO var` is PL/pgSQL variable assignment
 *     and not a write at all; separating the two needs to know whether the
 *     target is a table or a declared variable, and the table form creates a
 *     new relation rather than rewriting existing rows.
 *   - `COPY t FROM …` — it needs a file on the database host or `FROM STDIN`,
 *     and the boot migrator supplies neither, so it cannot execute from this
 *     directory in the first place.
 *
 * Neither is idiomatic in a drizzle migration. If either ever becomes
 * reachable here it is one alternation entry in `DML` plus one branch in
 * `dmlTarget` — named now so the omission is a decision on the record rather
 * than a gap someone rediscovers.
 */
export function licencedTables(sanitized: string): Set<string> {
  const statements = [...sanitized.matchAll(new RegExp(TABLE_STATEMENT, "gi"))];
  const tables = new Set<string>();
  for (const licence of sanitized.matchAll(LICENCE)) {
    if (isDeferredCheck(sanitized, licence)) continue;
    const enclosing = statements.filter((s) => s.index < licence.index).at(-1);
    if (enclosing?.[1] !== undefined) tables.add(normalizeTable(enclosing[1]));
  }
  return tables;
}

/**
 * A `CHECK` added `NOT VALID`, which licences nothing.
 *
 * §2 licences a repair beside the CLAUSE that enforces a constraint, not
 * beside its birth — which is why `VALIDATE CONSTRAINT` is matched on its own.
 * `CHECK (…)` is the one licence token that IS a birth, and
 * `ADD CONSTRAINT … CHECK (…) NOT VALID` enforces nothing at all: Postgres
 * skips the existing rows precisely so the table is not scanned yet. The
 * repair those rows need belongs beside the later `VALIDATE CONSTRAINT`, in
 * the file that actually turns the constraint on, and `VALIDATE` licences it
 * there.
 *
 * Without this, following §2's own advice — add `NOT VALID` now, repair and
 * validate later — silently licences arbitrary repair in the FIRST file, the
 * one where nothing is being enforced.
 */
function isDeferredCheck(sanitized: string, licence: RegExpExecArray): boolean {
  if (!/CHECK\s*\($/i.test(licence[0])) return false;

  // The CHECK's own ACTION, not its whole statement. `ALTER TABLE` takes a
  // comma-separated action list, so `ADD CONSTRAINT a CHECK (…), ADD CONSTRAINT
  // b FOREIGN KEY (…) NOT VALID` puts an enforced CHECK and an unrelated
  // deferred FK inside one `;`. Scanning to the `;` let the FK's `NOT VALID`
  // disarm the CHECK — a false positive against a legitimate shape.
  //
  // So: skip the CHECK's parenthesised expression by matching its parens, then
  // read only up to the next `,` or `;` at depth 0. That span is where this
  // constraint's own trailing `NOT VALID` would sit.
  const open = sanitized.lastIndexOf("(", licence.index + licence[0].length);
  let depth = 0;
  let i = open;
  for (; i < sanitized.length; i += 1) {
    const ch = sanitized[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        i += 1;
        break;
      }
    }
  }
  let end = i;
  let nested = 0;
  for (; end < sanitized.length; end += 1) {
    const ch = sanitized[end];
    if (ch === "(") nested += 1;
    else if (ch === ")") nested -= 1;
    else if (nested === 0 && (ch === "," || ch === ";")) break;
  }
  return /\bNOT\s+VALID\b/i.test(sanitized.slice(i, end));
}

/**
 * The offending statement, trimmed to something readable in a build log.
 *
 * The text is sliced out of the ORIGINAL source — `sanitize` preserves every
 * byte offset precisely so this can quote what the author wrote rather than
 * `SET "status" = ;` with the literal blanked out. The end of the statement is
 * still found in the sanitized copy, so a `;` inside a string cannot truncate
 * it early.
 */
function statementAt(sql: string, sanitized: string, index: number): string {
  const semicolon = sanitized.indexOf(";", index);
  const end = semicolon === -1 ? sanitized.length : semicolon + 1;
  const text = sql.slice(index, end).replace(/\s+/g, " ").trim();
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

interface Finding {
  line: number;
  statement: string;
}

/**
 * Every row-rewriting statement in one migration that no constraint licences.
 *
 * The carve-out is applied per STATEMENT against `licencedTables`, so a file
 * may legitimately hold a backfill for the table it constrains and still be
 * flagged for a second, unrelated rewrite of another table.
 *
 * A DML statement whose target table cannot be read fails closed: an
 * unparseable target matches no licence, so it is reported rather than waved
 * through. A write that is not an `UPDATE` skips the carve-out entirely.
 */
export function findDml(sql: string): Finding[] {
  const sanitized = sanitize(sql);
  const licenced = licencedTables(sanitized);

  const findings: Finding[] = [];
  for (const match of sanitized.matchAll(DML)) {
    const index = match.index;
    if (!startsStatement(sanitized, index)) continue;
    if (LICENCEABLE.test(match[1] ?? "")) {
      const target = dmlTarget(sanitized, index);
      if (target !== null && licenced.has(target)) continue;
    }
    findings.push({
      line: sanitized.slice(0, index).split("\n").length,
      statement: statementAt(sql, sanitized, index),
    });
  }
  return findings;
}

/**
 * The whole gate over a set of migrations, keyed by name (no `.sql`).
 *
 * Pure, so `scripts/test/verify-no-migration-dml.test.ts` can hold both
 * directions against it — including the grandfathering — with fixtures rather
 * than by mutating `packages/db/drizzle/`.
 */
export function review(migrations: ReadonlyMap<string, string>): string[] {
  const problems: string[] = [];

  for (const [name, sql] of migrations) {
    if (GRANDFATHERED.includes(name)) continue;
    const findings = findDml(sql);
    if (findings.length === 0) continue;
    problems.push(
      `packages/db/drizzle/${name}.sql rewrites row contents:\n` +
        findings.map((f) => `    line ${f.line}: ${f.statement}`).join("\n") +
        `\n    → move it to scripts/migration/<NNNN>-<slug>.{sql,ts}`,
    );
  }

  // Liveness, in the spirit of `KNOWN_IGNORED` in `scripts/lint.ts`: an
  // exemption that names nothing would silently excuse whatever lands at that
  // name tomorrow. Existence, and deliberately NOT "still flagged": two of the
  // eight are already covered by a carve-out as well (see `GRANDFATHERED`), and
  // a liveness check would demand their removal — converting an immutable file
  // from permanently exempt to exempt-while-the-regex-says-so, which is the one
  // thing that list exists not to be. Membership is a historical fact, so it is
  // not re-derived from today's rules.
  const dead = GRANDFATHERED.filter((name) => !migrations.has(name));
  if (dead.length > 0) {
    problems.push(
      `${dead.length} GRANDFATHERED entr(y|ies) in scripts/verify-no-migration-dml.ts name a ` +
        `migration that is not in packages/db/drizzle/:\n` +
        dead.map((n) => `    - ${n}`).join("\n") +
        `\n    The file was renamed or removed. Repoint the entry, or delete it.`,
    );
  }

  return problems;
}

function main(): number {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const problems = review(
    new Map(files.map((f) => [basename(f, ".sql"), readFileSync(join(MIGRATIONS_DIR, f), "utf8")])),
  );

  if (problems.length > 0) {
    for (const p of problems) console.error(`❌ ${p}`);
    console.error(
      `\nA drizzle migration describes the SCHEMA — it is replayed on every database, forever.\n` +
        `A one-off rewrite of row contents belongs in scripts/migration/<NNNN>-<slug>.{sql,ts},\n` +
        `run deliberately by an operator. See docs/NO_TRANSITIONAL_CODE.md §2.\n` +
        `The exceptions, already applied above: a backfill that is the precondition of a\n` +
        `SET NOT NULL / CHECK / VALIDATE CONSTRAINT, or a fold whose source column the file\n` +
        `DROPs — either way on the SAME TABLE, in the same file.`,
    );
    return 1;
  }

  console.log(
    `✅ no data repair in drizzle migrations — ${files.length} file(s) scanned, ` +
      `${GRANDFATHERED.length} grandfathered.`,
  );
  return 0;
}

// Guarded so `scripts/test/verify-no-migration-dml.test.ts` can import the pure
// helpers without scanning the real directory — same pattern as `lint.ts`.
if (import.meta.main) {
  process.exit(main());
}
