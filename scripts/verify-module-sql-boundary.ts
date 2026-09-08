// SPDX-License-Identifier: Apache-2.0

/**
 * Architecture test — a module with its own database touches its OWN tables only.
 *
 * `apps/api/src/modules/README.md` rule 4 lets a module whose tables the
 * Apache-2.0 core schema must not carry keep a drizzle tree of its own and
 * self-migrate it — and `@appstrate/module-ee` migrates that tree into the
 * PLATFORM database (`DATABASE_URL`, see `packages/module-ee/src/db.ts`). The
 * rule that comes with the escape hatch is "reads platform data through
 * `ctx.services`, never a SQL join across the licence boundary", and until this
 * gate existed that rule was prose only: the module's pool can reach
 * `organizations` and `llm_usage` because they are literally in the same
 * database, so `sql`SELECT … FROM organizations`` compiles, runs, returns rows
 * and passes typecheck, lint, knip, the isolation gate and every test.
 *
 * What it enforces, per module package that owns a migration journal:
 *
 *   1. No platform schema import. `@appstrate/db` (any subpath) and any
 *      relative import landing in `packages/db/` are refused outright — the
 *      drizzle table OBJECT is the other way a cross-boundary join is written,
 *      and it names no table in any string this scan could read.
 *   2. No foreign table in raw SQL. Every `sql` tagged template, `sql.raw(…)`,
 *      `.execute("…")` and `.unsafe("…")` is read as SQL, the identifiers after
 *      `FROM` / `JOIN` / `INTO` / `UPDATE` / `DELETE FROM` / `TRUNCATE` are
 *      extracted, and anything that is not one of the module's own tables (read
 *      from its newest drizzle snapshot) or a PostgreSQL catalog relation
 *      (`pg_*`, `information_schema.*`, the `drizzle.*` journal) fails.
 *
 * The two rules compose: a drizzle table object interpolated into a template
 * (`FROM ${organizations}`) leaves nothing for rule 2 to read, and is caught by
 * rule 1 at the import that had to precede it.
 *
 * SCOPE — this reads SQL that is WRITTEN in the module. A query string built at
 * runtime from a variable is not readable here and is not covered; the module
 * writes none today, and rule 1 removes the ergonomic way to write one.
 *
 * Usage: bun scripts/verify-module-sql-boundary.ts
 */

import { Glob } from "bun";
import { dirname, relative, resolve, sep } from "node:path";
import { moduleOwnedTables } from "./lib/drizzle-snapshots.ts";
import { importSpecifiers } from "./verify-module-isolation.ts";

const ROOT = resolve(dirname(Bun.fileURLToPath(import.meta.url)), "..");

/**
 * Characters after which a `/` opens a regex literal rather than a division —
 * the same set `verify-module-isolation.ts` walks with, and for the same
 * reason: an unterminated regex would swallow the code behind it and blank a
 * whole file's SQL out of the scan.
 */
const REGEX_PRECEDERS = new Set("(,=:[!&|?{};+-*%~^");

/** The tail of already-emitted code that makes a template literal SQL. */
const SQL_TAG = /(?:^|[^\w$.])sql\s*$/;

/** The tail that makes ANY string or template literal a SQL argument. */
const SQL_CALL = /(?:sql\s*\.\s*raw|\.\s*execute|\.\s*unsafe)\s*\(\s*$/;

/**
 * Everything the scan must not read, blanked to spaces — byte offsets and line
 * numbers survive, so a finding can be reported at its real line.
 *
 * The output is the file's SQL and nothing else: comments go (a header
 * discussing `FROM organizations` in prose is not a query), and so does every
 * string literal that is not itself SQL (a log message, an error string, an
 * import specifier). The bodies that SURVIVE are the ones a database executes —
 * a `` sql`…` `` tagged template and the string argument of `sql.raw`,
 * `.execute` and `.unsafe` — which is the same "blank what does not execute"
 * split `verify-no-migration-dml.ts`'s `sanitize` makes one level down, in SQL
 * rather than in TypeScript.
 *
 * `${…}` interpolations inside a surviving template are blanked too. They are
 * values and drizzle column/table objects, not identifiers this scan can read;
 * leaving them in would make `FROM ${orgUsageRecords}` look like a table named
 * `orgUsageRecords`. What an interpolated TABLE object really is, rule 1 sees
 * at its import.
 *
 * `literals` counts the SQL-bearing literals kept. It is not decoration: a
 * module can hold zero table references legitimately (today's does — every
 * query it writes goes through drizzle's builder), and a scanner that had
 * stopped recognising `` sql`…` `` altogether would report the same zero. The
 * count line prints both numbers so the two cases are distinguishable.
 */
export function sqlText(source: string): { text: string; literals: number } {
  let out = "";
  let prev = "";
  let i = 0;
  let literals = 0;

  const keep = (n: number): void => {
    out += source.slice(i, i + n);
    i += n;
  };
  const blank = (n: number): void => {
    for (const ch of source.slice(i, i + n)) out += ch === "\n" ? "\n" : " ";
    i += n;
  };

  while (i < source.length) {
    const ch = source[i]!;

    if (ch === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);
      blank((end === -1 ? source.length : end) - i);
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      blank((end === -1 ? source.length : end + 2) - i);
      continue;
    }
    if (ch === "/" && (prev === "" || REGEX_PRECEDERS.has(prev))) {
      blank(scanQuoted(source, i, "/") - i);
      prev = "/";
      continue;
    }
    if (ch === '"' || ch === "'") {
      const end = scanQuoted(source, i, ch);
      if (SQL_CALL.test(out)) {
        literals += 1;
        blank(1);
        keep(Math.max(end - 1 - i, 0));
        blank(end - i);
      } else {
        blank(end - i);
      }
      prev = ch;
      continue;
    }
    if (ch === "`") {
      const isSql = SQL_TAG.test(out) || SQL_CALL.test(out);
      if (isSql) literals += 1;
      blank(1);
      while (i < source.length && source[i] !== "`") {
        if (source[i] === "\\") {
          blank(Math.min(2, source.length - i));
          continue;
        }
        if (source[i] === "$" && source[i + 1] === "{") {
          blank(skipInterpolation(source, i) - i);
          continue;
        }
        if (isSql) keep(1);
        else blank(1);
      }
      if (i < source.length) blank(1);
      prev = "`";
      continue;
    }

    keep(1);
    if (!/\s/.test(ch)) prev = ch;
  }

  return { text: out, literals };
}

/**
 * Index just past the literal opened at `start` with `quote`. Handles the
 * backslash escape, which is what keeps `"a\"b"` from ending at the middle
 * quote and inverting every blanking decision after it.
 */
function scanQuoted(source: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < source.length) {
    if (source[i] === "\\") i += 2;
    else if (source[i] === quote) return i + 1;
    else if (quote === "/" && source[i] === "\n") return i;
    else i += 1;
  }
  return source.length;
}

/**
 * Index just past the `${…}` opened at `start`.
 *
 * Braces are counted, and string / template literals inside are skipped whole:
 * `${cond ? "}" : x}` closes on the wrong brace otherwise, and a nested
 * template (`${a}${`b${c}`}`) needs the recursion this loop performs by
 * re-entering on its own backtick branch.
 */
function skipInterpolation(source: string, start: number): number {
  let i = start + 2;
  let depth = 1;
  while (i < source.length && depth > 0) {
    const ch = source[i]!;
    if (ch === '"' || ch === "'" || ch === "`") {
      if (ch === "`") {
        i += 1;
        while (i < source.length && source[i] !== "`") {
          if (source[i] === "\\") i += 2;
          else if (source[i] === "$" && source[i + 1] === "{") i = skipInterpolation(source, i);
          else i += 1;
        }
        i += 1;
      } else {
        i = scanQuoted(source, i, ch);
      }
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    i += 1;
  }
  return i;
}

/**
 * The clauses that name a table, and the identifier each one takes.
 *
 * `DELETE FROM` and `INSERT INTO` are covered by the bare `FROM` / `INTO`
 * alternatives — the keyword before them changes nothing about which token is
 * the table.
 */
const TABLE_CLAUSE =
  /\b(FROM|JOIN|INTO|UPDATE|TRUNCATE)\s+(?:TABLE\s+)?(?:ONLY\s+)?([A-Za-z_"][\w".$]*)/gi;

/**
 * Words that follow one of those keywords without being a table.
 *
 * `ON CONFLICT DO UPDATE SET` is the one that matters here — it is how every
 * upsert in the module is written, and without this the gate would report a
 * table called `SET` in a dozen files.
 */
const NOT_A_TABLE = new Set([
  "SET",
  "SELECT",
  "VALUES",
  "WHERE",
  "RETURNING",
  "LATERAL",
  "DISTINCT",
  "ALL",
]);

/** One table identifier a module's SQL names, with where it was written. */
export interface TableReference {
  /** The identifier verbatim, quotes and schema qualifier included. */
  table: string;
  /** 1-based line in the file the SQL came from. */
  line: number;
}

/**
 * Every table identifier in a file's SQL, given the blanked view `sqlText`
 * produced. A name immediately followed by `(` is a function call
 * (`FROM generate_series(…)`, `extract(epoch FROM now())`) and is not a table.
 */
export function findTableReferences(sqlOnly: string): TableReference[] {
  const refs: TableReference[] = [];
  for (const match of sqlOnly.matchAll(TABLE_CLAUSE)) {
    const table = match[2]!;
    if (NOT_A_TABLE.has(table.toUpperCase())) continue;
    if (sqlOnly[match.index + match[0].length] === "(") continue;
    refs.push({ table, line: sqlOnly.slice(0, match.index).split("\n").length });
  }
  return refs;
}

/**
 * Relations any module may name: PostgreSQL's own catalogs, plus the `drizzle`
 * journal schema its migrator writes to. Everything else has an owner.
 */
export function isSystemRelation(name: string): boolean {
  const lower = name.replaceAll('"', "").toLowerCase();
  const dot = lower.indexOf(".");
  if (dot === -1) return lower.startsWith("pg_");
  const schema = lower.slice(0, dot);
  return (
    schema === "pg_catalog" ||
    schema === "information_schema" ||
    schema === "drizzle" ||
    lower.slice(dot + 1).startsWith("pg_")
  );
}

/** Is `name` one of `own` — bare, or qualified as `public.<name>`? */
function isOwnTable(name: string, own: ReadonlySet<string>): boolean {
  const lower = name.replaceAll('"', "").toLowerCase();
  const dot = lower.indexOf(".");
  if (dot === -1) return own.has(lower);
  return lower.slice(0, dot) === "public" && own.has(lower.slice(dot + 1));
}

/** One module source file, as the scan reads it. */
export interface ScannedFile {
  /** Repo-relative path, for the report. */
  file: string;
  source: string;
}

/**
 * The problems one module's files commit, given the tables it owns. Pure — the
 * scan feeds it the real tree, `scripts/test/verify-module-sql-boundary.test.ts`
 * feeds it synthetic files.
 */
export function reviewModuleSql(
  moduleId: string,
  files: readonly ScannedFile[],
  ownTables: ReadonlySet<string>,
): { problems: string[]; references: number; literals: number } {
  const problems: string[] = [];
  let references = 0;
  let literals = 0;

  for (const { file, source } of files) {
    for (const spec of importSpecifiers(source)) {
      const resolved = spec.startsWith(".") ? spec : undefined;
      const platform =
        /^@appstrate\/db(\/|$)/.test(spec) ||
        (resolved !== undefined && /(^|\/)packages\/db\//.test(spec));
      if (!platform) continue;
      problems.push(
        `${file} imports \`${spec}\` — the platform's drizzle schema. Module \`${moduleId}\` ` +
          `keeps its tables in the platform database, so a table object imported here joins ` +
          `across the licence boundary and compiles. Read platform data through \`ctx.services\`.`,
      );
    }

    const sql = sqlText(source);
    literals += sql.literals;
    for (const ref of findTableReferences(sql.text)) {
      references += 1;
      if (isOwnTable(ref.table, ownTables) || isSystemRelation(ref.table)) continue;
      problems.push(
        `${file}:${ref.line} names table \`${ref.table}\` in SQL, which module \`${moduleId}\` ` +
          `does not own. Its own tables are the ${ownTables.size} its drizzle snapshot declares; ` +
          `platform data is read through \`ctx.services\`, never a SQL join across the licence ` +
          `boundary (apps/api/src/modules/README.md, rule 4).`,
      );
    }
  }

  return { problems, references, literals };
}

/**
 * Every file of a module package the scan reads: its own `.ts`/`.tsx`, tests
 * and installed dependencies excluded.
 *
 * The root is the PACKAGE, not `src/` — `packages/module-ee/drizzle/schema.ts`
 * is production code that names tables and sits outside `src/`, which is
 * exactly the file this gate must not be blind to.
 */
async function moduleSourceFiles(packageDir: string): Promise<ScannedFile[]> {
  const files: ScannedFile[] = [];
  const glob = new Glob("**/*.{ts,tsx}");
  for await (const rel of glob.scan({ cwd: packageDir })) {
    if (rel.includes("node_modules/")) continue;
    if (rel.startsWith("test/") || rel.includes("/test/") || /\.test\.tsx?$/.test(rel)) continue;
    const path = resolve(packageDir, rel);
    files.push({
      file: relative(ROOT, path).split(sep).join("/"),
      source: await Bun.file(path).text(),
    });
  }
  return files.sort((a, b) => a.file.localeCompare(b.file));
}

if (import.meta.main) {
  const modules = await moduleOwnedTables(ROOT);

  const problems: string[] = [];
  let filesScanned = 0;
  let references = 0;
  let literals = 0;

  for (const module of modules) {
    // A module whose snapshot declares nothing would accept every table name in
    // the repository. That is a broken snapshot, not a clean module.
    if (module.tables.size === 0) {
      problems.push(
        `module \`${module.id}\` owns a migration journal but ${module.snapshot} declares zero ` +
          `tables — every table name would read as its own and this gate would pass vacuously.`,
      );
      continue;
    }
    const files = await moduleSourceFiles(resolve(ROOT, module.packageDir));
    filesScanned += files.length;
    const review = reviewModuleSql(module.id, files, module.tables);
    references += review.references;
    literals += review.literals;
    problems.push(...review.problems);
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`❌ ${problem}`);
    process.exit(1);
  }

  const owned = modules.reduce((n, m) => n + m.tables.size, 0);
  console.log(
    `✅ module SQL boundary clean — ${filesScanned} files across ${modules.length} module(s) ` +
      `with a database of their own, ${literals} raw-SQL literal(s) read, ${references} table ` +
      `reference(s) in them checked against ${owned} module-owned table(s).`,
  );
}
