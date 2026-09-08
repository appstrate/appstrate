/// <reference types="bun" />

/**
 * Gate — data repair must not live in a drizzle migration.
 *
 * The rule this enforces, and every reason behind it, is stated once — in the
 * platform's `docs/NO_TRANSITIONAL_CODE.md` §2, which is the authority for this
 * repo too. Read it there. This header describes the implementation only.
 *
 * Ported from the platform's `scripts/verify-no-migration-dml.ts`. The rule is
 * the same, so the logic is the same, deliberately: only the migrations
 * directory (`drizzle/migrations/` here, `packages/db/drizzle/` there) and the
 * grandfather list differ. Keep it that way — a divergence in the detector
 * would mean the two repos enforce two different rules under one name.
 *
 * What the code does: reject every `UPDATE` / `INSERT` / `DELETE` / `TRUNCATE`
 * that opens a statement in a new migration, UNLESS the same file also
 * constrains THAT TABLE with a `SET NOT NULL`, a `CHECK`, or a `VALIDATE
 * CONSTRAINT` — the carve-out §2 names. Same table, not merely the same file:
 * see `licencedTables`, which also records the one hole this deliberately
 * leaves open. A `TRUNCATE` is never licenced — see `UNLICENCEABLE`.
 *
 * Only NEW files are gated. Every migration already in the directory has run
 * on real databases and cannot be changed, so the two that predate this rule
 * are listed in `GRANDFATHERED` below — explicitly, so the exemption is
 * reviewable rather than implicit, and checked against the directory so an
 * entry cannot go on excusing a name nothing occupies.
 */

import { basename, join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";

const REPO_ROOT = join(import.meta.dir, "..");
const MIGRATIONS_DIR_REL = "drizzle/migrations";
const MIGRATIONS_DIR = join(REPO_ROOT, MIGRATIONS_DIR_REL);

/**
 * Migrations that carry data repair and predate this gate.
 *
 * These are permanent — they have been applied to production databases, and a
 * drizzle migration is never edited after it ships. The list is therefore
 * frozen: it may shrink (a file leaves the directory), never grow. A third
 * entry means a new migration slipped the gate, not that the list was short.
 *
 * The set was established by READING all four files in the directory.
 * `0000_init` and `0002_numeric_cost` are pure DDL and are absent for that
 * reason.
 *
 * `0003_normalize_free_subscription_status` is the live one: the whole file is
 * a single `UPDATE "cloud_billing_accounts" SET subscription_status = NULL …`
 * with no DDL at all — "normalize legacy rows", which is precisely the
 * `scripts/migration/` job §2 describes. Only its presence here keeps the gate
 * green.
 *
 * `0001_cursor_billing` is the no-op. It holds TWO row rewrites of
 * `cloud_usage_records`, and the table-level carve-out exempts both before this
 * list is consulted:
 *
 *   - the `context_type` / `context_id` backfill genuinely IS a precondition —
 *     the columns are added nullable, backfilled, then promoted with
 *     `SET NOT NULL` in the same file;
 *   - the `cost_usd = cost_credits / 1000.0` backfill is NOT. `cost_usd` is
 *     added `double precision DEFAULT 0 NOT NULL` ten lines above it, and a
 *     `NOT NULL` in a column DEFINITION is satisfied by its `DEFAULT` — no
 *     backfill was ever its precondition. It restores a money invariant, which
 *     is data repair. The table-level carve-out cannot tell the two apart
 *     because both land on `cloud_usage_records`; that residual limit is the
 *     one `licencedTables` documents.
 *
 * It stays listed because it IS pre-existing data repair, a reviewer auditing
 * the exemption should see the same two either way, and if the carve-out is
 * ever narrowed to columns it becomes live without further archaeology.
 */
export const GRANDFATHERED: readonly string[] = [
  "0001_cursor_billing",
  "0003_normalize_free_subscription_status",
];

/**
 * Blank out everything SQL does not execute, keeping every byte offset.
 *
 * Comments and string literals are replaced by spaces (newlines survive, so
 * line numbers stay true) rather than deleted, because a migration header
 * discussing `UPDATE` in prose is the common case here — `0001` alone mentions
 * `UPDATE` and `DROP` throughout its comment block — and a literal
 * `'... DELETE ...'` is not a statement either.
 *
 * Dollar-quoted bodies (`$$ … $$`) are deliberately NOT blanked: a `DO $$ …
 * INSERT … END $$` block is exactly the shape this gate must still see —
 * `0001` step 3 is that shape.
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
 * most total row rewrite there is. See `UNLICENCEABLE` for why it never
 * reaches the carve-out.
 */
const DML = /\b(UPDATE|INSERT|DELETE|TRUNCATE)\b/gi;

/**
 * Writes that the same-table carve-out can never licence.
 *
 * A `TRUNCATE` empties the table. It cannot be the *precondition* of a
 * constraint in any sense worth honouring — emptying a table satisfies every
 * constraint vacuously, so licencing it would let "drop all rows, then add a
 * `SET NOT NULL`" pass a gate whose entire purpose is to stop a migration from
 * destroying data on every database it is ever replayed against.
 *
 * This is also why `dmlTarget` never parses a `TRUNCATE`, and why its
 * comma-separated form (`TRUNCATE a, b, c`) needs no handling: with no
 * exemption available there is no target to match against, and every table in
 * the list is reported through the statement text either way.
 */
const UNLICENCEABLE = /^TRUNCATE$/i;

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
 * The three clauses whose precondition a backfill can legitimately be.
 *
 * `SET NOT NULL` and not a bare `NOT NULL`, which is the narrowing
 * `docs/NO_TRANSITIONAL_CODE.md` §2 already states — only a *promotion*
 * counts. A `NOT NULL` in a column DEFINITION is not a promotion — Postgres
 * refuses `ADD COLUMN … NOT NULL` on a populated table without a `DEFAULT`,
 * and that default already satisfies the constraint, so no backfill was ever
 * its precondition. It also drops the `IS NOT NULL` problem for free: a
 * `WHERE` predicate cannot match this shape at all.
 */
const LICENCE = /\bSET\s+NOT\s+NULL\b|\bCHECK\s*\(|\bVALIDATE\s+CONSTRAINT\b/gi;

/**
 * Every table this file adds a constraint to.
 *
 * Same-TABLE, not file-level, and that is the whole of the carve-out's
 * strength. File-level, any unrelated `SET NOT NULL` or `CHECK` anywhere in
 * the file licences any data repair anywhere else in it — a bypass a future
 * author reaches by accident, not by intent: add a constrained column to table
 * A, fold some rows on table B, gate green.
 *
 * ─── What this does NOT catch ───────────────────────────────────────
 *
 * A constraint and an unrelated data repair on the SAME table.
 * `0001_cursor_billing` is the live example: `cloud_usage_records` gains a
 * genuine `SET NOT NULL` promotion (`context_type` / `context_id`, backfilled
 * in the same file — the carve-out working as intended), and the same file also
 * backfills `cost_usd` from `cost_credits`, which is plain data repair on a
 * column no promotion covers. Structurally the two are indistinguishable at the
 * table boundary.
 *
 * Telling them apart needs column-level analysis — resolving which columns a
 * CHECK expression reads and which ones an UPDATE assigns — and that is
 * deliberately out of scope for a lint script. The gate stops at the table
 * boundary, and says so here rather than implying a reach it does not have.
 *
 * Two writing forms are also outside the `DML` vocabulary, on purpose:
 *
 *   - `SELECT … INTO t FROM …` — inside a `DO $$` body, which this gate
 *     deliberately reads, `SELECT … INTO var` is PL/pgSQL variable assignment
 *     and not a write at all; separating the two needs to know whether the
 *     target is a table or a declared variable, and the table form creates a
 *     new relation rather than rewriting existing rows.
 *   - `COPY t FROM …` — it needs a file on the database host or `FROM STDIN`,
 *     and cloud's self-migrator (`migrateCloudDb`) supplies neither, so it
 *     cannot execute from this directory in the first place.
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
    const enclosing = statements.filter((s) => s.index < licence.index).at(-1);
    if (enclosing?.[1] !== undefined) tables.add(normalizeTable(enclosing[1]));
  }
  return tables;
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
 * through. An `UNLICENCEABLE` write skips the carve-out entirely.
 */
export function findDml(sql: string): Finding[] {
  const sanitized = sanitize(sql);
  const licenced = licencedTables(sanitized);

  const findings: Finding[] = [];
  for (const match of sanitized.matchAll(DML)) {
    const index = match.index;
    if (!startsStatement(sanitized, index)) continue;
    if (!UNLICENCEABLE.test(match[1] ?? "")) {
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
 * Pure, so `test/unit/verify-no-migration-dml.test.ts` can hold both directions
 * against it — including the grandfathering — with fixtures rather than by
 * mutating `drizzle/migrations/`.
 */
export function review(migrations: ReadonlyMap<string, string>): string[] {
  const problems: string[] = [];

  for (const [name, sql] of migrations) {
    if (GRANDFATHERED.includes(name)) continue;
    const findings = findDml(sql);
    if (findings.length === 0) continue;
    problems.push(
      `${MIGRATIONS_DIR_REL}/${name}.sql rewrites row contents:\n` +
        findings.map((f) => `    line ${f.line}: ${f.statement}`).join("\n") +
        `\n    → move it to scripts/migration/<NNNN>-<slug>.{sql,ts}`,
    );
  }

  // Liveness: an exemption that names nothing would silently excuse whatever
  // lands at that name tomorrow. Existence, not "still flagged" — one of the
  // two is covered by the constraint carve-out as well (see `GRANDFATHERED`),
  // and failing on that would only push the list out of sync with the files.
  const dead = GRANDFATHERED.filter((name) => !migrations.has(name));
  if (dead.length > 0) {
    problems.push(
      `${dead.length} GRANDFATHERED entr(y|ies) in scripts/verify-no-migration-dml.ts name a ` +
        `migration that is not in ${MIGRATIONS_DIR_REL}/:\n` +
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
        `run deliberately by an operator. See scripts/migration/README.md and the platform's\n` +
        `docs/NO_TRANSITIONAL_CODE.md §2.\n` +
        `The one exception, already applied above: a backfill that is the precondition of a\n` +
        `SET NOT NULL / CHECK / VALIDATE CONSTRAINT on the SAME TABLE, in the same file.`,
    );
    return 1;
  }

  console.log(
    `✅ no data repair in drizzle migrations — ${files.length} file(s) scanned, ` +
      `${GRANDFATHERED.length} grandfathered.`,
  );
  return 0;
}

// Guarded so `test/unit/verify-no-migration-dml.test.ts` can import the pure
// helpers without scanning the real directory.
if (import.meta.main) {
  process.exit(main());
}
