// SPDX-License-Identifier: Apache-2.0

/**
 * Architecture test — a module with its own database touches its OWN tables only.
 * `apps/api/src/modules/README.md` rule 4: such a module reads platform data through
 * `ctx.services`, never a SQL join across the licence boundary. Per module package owning a
 * migration journal, this refuses any `@appstrate/db` / `packages/db/` import and any foreign
 * table named in raw SQL. Scope: only SQL written literally in the module is read.
 * Usage: bun scripts/verify-module-sql-boundary.ts
 */

import { Glob } from "bun";
import { dirname, relative, resolve, sep } from "node:path";
import { moduleOwnedTables } from "./lib/drizzle-snapshots.ts";
import { REGEX_PRECEDERS, scanQuoted, skipInterpolation } from "./lib/ts-lexer.ts";
import { importSpecifiers } from "./verify-module-isolation.ts";

const ROOT = resolve(dirname(Bun.fileURLToPath(import.meta.url)), "..");

/** The tail of already-emitted code that makes a template literal SQL. */
const SQL_TAG = /(?:^|[^\w$.])sql\s*$/;

/** The tail that makes ANY string or template literal a SQL argument. */
const SQL_CALL = /(?:sql\s*\.\s*raw|\.\s*execute|\.\s*unsafe)\s*\(\s*$/;

/**
 * Blanks to spaces everything the scan must not read, preserving offsets so a finding reports at
 * its real line. Kept is what a database executes: a `` sql`…` `` tagged template and the string
 * argument of `sql.raw`, `.execute` and `.unsafe`, minus their `${…}` interpolations. `literals`
 * counts the SQL literals kept, so a legitimate zero table references is distinguishable from a
 * scanner that stopped recognising `` sql`…` `` at all.
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

/** The clauses that name a table; `DELETE FROM` / `INSERT INTO` fall under `FROM` / `INTO`. */
const TABLE_CLAUSE =
  /\b(FROM|JOIN|INTO|UPDATE|TRUNCATE)\s+(?:TABLE\s+)?(?:ONLY\s+)?([A-Za-z_"][\w".$]*)/gi;

/** Words that follow one of those keywords without being a table (`ON CONFLICT DO UPDATE SET`). */
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

interface TableReference {
  table: string;
  /** 1-based line in the file the SQL came from. */
  line: number;
}

/** Every table identifier in `sqlText`'s output; a name followed by `(` is a call, not a table. */
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

/** Relations any module may name: PostgreSQL catalogs, plus the `drizzle` journal schema. */
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

/** One module source file, as the scan reads it; `file` is repo-relative, for the report. */
export interface ScannedFile {
  file: string;
  source: string;
}

/** The problems one module's files commit, given the tables it owns. Pure, so tests can feed it
 * synthetic files. */
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
 * The refusal a module earns by owning a migration journal while declaring no tables — `null`
 * when it declares some. An empty table set makes every identifier read as its own, so the
 * gate would pass vacuously.
 */
export function reviewModuleSnapshot(module: {
  id: string;
  snapshot: string;
  tables: ReadonlySet<string>;
}): string | null {
  if (module.tables.size > 0) return null;
  return (
    `module \`${module.id}\` owns a migration journal but ${module.snapshot} declares zero ` +
    `tables — every table name would read as its own and this gate would pass vacuously.`
  );
}

/**
 * Every file of a module package the scan reads: its own `.ts`/`.tsx`, tests and installed
 * dependencies excluded. The root is the PACKAGE, not `src/`: `drizzle/schema.ts` names tables.
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
    const vacuous = reviewModuleSnapshot(module);
    if (vacuous !== null) {
      problems.push(vacuous);
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
