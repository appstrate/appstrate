// SPDX-License-Identifier: Apache-2.0
/// <reference types="bun" />

/**
 * The test suite, split across processes. `bun run test:tier0` is this script
 * with `TEST_TIER=0`.
 *
 * `bun test` runs every file in ONE process, so the suite used one core however
 * many the machine has. Measured on `apps/api/test/integration` in tier 0:
 * 412 s in one process, 63 s over six, with identical pass/skip counts. Tier 0
 * needs nothing else to allow it — each process owns its database (a private
 * PGlite directory), its storage directory and in-memory infra (see
 * `test/setup/preload.ts`). Tier 3 shares one PostgreSQL, Redis, MinIO and DinD,
 * so it runs as a single process here; CI spreads it across machines instead,
 * with `--partition`.
 *
 *   bun scripts/run-tests.ts [path-filter…] [--shards=N] [--partition=I/K] [bun test flags…]
 *
 * - A path filter keeps the files whose repo-relative path contains it, as the
 *   positional arguments of `bun test` do.
 * - `--shards=N` — processes to run. Default: `APPSTRATE_TEST_SHARDS`, else the
 *   available cores minus two, capped at 8. Always 1 in tier 3.
 * - `--partition=I/K` — run only the I-th of K slices of the file list, in one
 *   process. The slicing weighs files by size alone, so every machine computes
 *   the same K slices and together they cover the list exactly once.
 * - `--path-ignore-patterns=GLOB` — ADDED to bunfig's `pathIgnorePatterns`
 *   (where `bun test` would replace them).
 * - Any other flag is handed to every `bun test` unchanged. With `--coverage`
 *   and more than one process, each writes its report to `<coverage-dir>/shard-<n>/`.
 *
 * Files are collected from git (tracked, plus untracked files git does not
 * ignore), which keeps local scratch directories and nested worktrees out of a
 * run. Modules the current tier cannot load are excluded the way the preload
 * declines them (`test/setup/modules.ts`).
 *
 * The files are dealt to the processes by their measured duration, kept in
 * `node_modules/.cache/appstrate-test/timings.json` and refreshed by every run;
 * a file never measured is weighed by its size. Each process's output is
 * printed when it finishes, then one summary for the whole run.
 */

import { availableParallelism } from "node:os";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { discoverModules, loadModuleRequirements, skipsInTier } from "../test/setup/modules.ts";

const ROOT = resolve(import.meta.dir, "..");
const TIER0 = process.env.TEST_TIER === "0";
const CACHE_DIR = join(ROOT, "node_modules/.cache/appstrate-test");
const TIMINGS_FILE = join(CACHE_DIR, "timings.json");
/** The file names `bun test` collects. */
const TEST_FILE = /[._](test|spec)\.(js|jsx|ts|tsx)$/;
/** `bun test` flags whose value may come as the NEXT argument. */
const VALUE_FLAGS = new Set([
  "-t",
  "--test-name-pattern",
  "--timeout",
  "--rerun-each",
  "--preload",
  "--max-concurrency",
  "--seed",
  "--reporter",
  "--reporter-outfile",
  "--coverage-reporter",
  "--coverage-dir",
]);

export interface Options {
  shards?: number;
  partition?: { index: number; count: number };
  filters: string[];
  ignores: string[];
  forwarded: string[];
}

export function parseArgs(argv: readonly string[]): Options {
  const options: Options = { filters: [], ignores: [], forwarded: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const eq = arg.indexOf("=");
    const flag = arg.startsWith("-") && eq > 0 ? arg.slice(0, eq) : arg;
    const value = (): string => {
      const inline = eq > 0 && arg.startsWith("-") ? arg.slice(eq + 1) : argv[++i];
      if (inline === undefined) throw new Error(`${flag} needs a value.`);
      return inline;
    };
    if (flag === "--shards") {
      const n = Number(value());
      if (!Number.isInteger(n) || n < 1) throw new Error("--shards must be a positive integer.");
      options.shards = n;
    } else if (flag === "--partition") {
      const match = /^(\d+)\/(\d+)$/.exec(value());
      const index = Number(match?.[1]);
      const count = Number(match?.[2]);
      if (!match || index < 1 || index > count) {
        throw new Error("--partition must be I/K with 1 <= I <= K, e.g. --partition=2/3.");
      }
      options.partition = { index, count };
    } else if (flag === "--path-ignore-patterns") {
      options.ignores.push(value());
    } else if (arg.startsWith("-")) {
      options.forwarded.push(arg);
      if (eq < 0 && VALUE_FLAGS.has(arg)) options.forwarded.push(value());
    } else {
      options.filters.push(relative(ROOT, resolve(arg)));
    }
  }
  return options;
}

export async function collectFiles(options: Options): Promise<string[]> {
  const bunfig = Bun.TOML.parse(await Bun.file(join(ROOT, "bunfig.toml")).text()) as {
    test?: { pathIgnorePatterns?: string[] };
  };
  const ignores = [...(bunfig.test?.pathIgnorePatterns ?? []), ...options.ignores];
  for (const { dir } of discoverModules(ROOT)) {
    if (!skipsInTier(await loadModuleRequirements(dir), TIER0)) continue;
    const rel = relative(ROOT, dir);
    ignores.push(`${rel}/**`);
    console.log(`tier0: excluding ${rel} — it requires a real PostgreSQL.`);
  }
  const globs = ignores.map((pattern) => new Bun.Glob(pattern));

  const listed = Bun.spawnSync(
    ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    {
      cwd: ROOT,
      stderr: "inherit",
    },
  );
  if (listed.exitCode !== 0) throw new Error("git ls-files failed — run this from the repository.");
  const files = new Set(
    listed.stdout
      .toString()
      .split("\0")
      .filter((file) => TEST_FILE.test(file))
      .filter((file) => !globs.some((glob) => glob.match(file)))
      .filter(
        (file) => options.filters.length === 0 || options.filters.some((f) => file.includes(f)),
      )
      // A tracked file deleted in the worktree is still in the index.
      .filter((file) => existsSync(join(ROOT, file))),
  );
  return [...files].sort();
}

/** Longest-processing-time first: each file, heaviest first, to the lightest bin. */
export function deal(
  files: readonly string[],
  bins: number,
  weight: (file: string) => number,
): string[][] {
  const loads = Array.from({ length: bins }, () => ({ load: 0, files: [] as string[] }));
  const heaviestFirst = [...files].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b));
  for (const file of heaviestFirst) {
    const lightest = loads.reduce((min, bin) => (bin.load < min.load ? bin : min));
    lightest.files.push(file);
    lightest.load += weight(file);
  }
  return loads.map((bin) => bin.files);
}

async function readTimings(): Promise<Record<string, number>> {
  try {
    return (await Bun.file(TIMINGS_FILE).json()) as Record<string, number>;
  } catch {
    return {};
  }
}

/** Seconds per file, summed from a `bun test --reporter=junit` report. */
async function junitTimings(path: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!(await Bun.file(path).exists())) return out;
  const xml = await Bun.file(path).text();
  for (const m of xml.matchAll(/<testcase [^>]*?time="([\d.]+)" file="([^"]+)"/g)) {
    out.set(m[2]!, (out.get(m[2]!) ?? 0) + Number(m[1]));
  }
  return out;
}

interface ShardResult {
  index: number;
  files: number;
  exitCode: number;
  seconds: number;
  output: string;
}

const COUNTS = /^\s*(\d+) (pass|fail|skip|todo|errors?)\b/gm;
// eslint-disable-next-line no-control-regex -- ANSI escape sequences.
const ANSI = /\u001b\[[0-9;]*m/g;

function counts(output: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of output.matchAll(COUNTS)) {
    const key = m[2]!.startsWith("error") ? "errors" : m[2]!;
    out[key] = (out[key] ?? 0) + Number(m[1]);
  }
  return out;
}

function withCoverageDir(forwarded: readonly string[], shard: number): string[] {
  if (!forwarded.includes("--coverage")) return [...forwarded];
  let dir = "coverage";
  const rest: string[] = [];
  for (let i = 0; i < forwarded.length; i++) {
    const arg = forwarded[i]!;
    if (arg === "--coverage-dir") dir = forwarded[++i]!;
    else if (arg.startsWith("--coverage-dir=")) dir = arg.slice("--coverage-dir=".length);
    else rest.push(arg);
  }
  return [...rest, `--coverage-dir=${join(dir, `shard-${shard}`)}`];
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const files = await collectFiles(options);
  if (files.length === 0) {
    console.error("No test file matches.");
    return 1;
  }

  let selected = files;
  if (options.partition) {
    const { index, count } = options.partition;
    selected = deal(files, count, (file) => Bun.file(join(ROOT, file)).size)[index - 1]!;
    console.log(`partition ${index}/${count}: ${selected.length} of ${files.length} files`);
  }

  const requested = options.shards ?? (Number(process.env.APPSTRATE_TEST_SHARDS) || undefined);
  if (!TIER0 && (requested ?? 1) > 1) {
    throw new Error(
      "Tier 3 runs one process: every process would share one PostgreSQL, Redis and MinIO. " +
        "Use TEST_TIER=0 to run in parallel, or --partition to split across machines.",
    );
  }
  const defaultShards = Math.max(1, Math.min(8, availableParallelism() - 2));
  const shardCount = Math.min(
    selected.length,
    options.partition || !TIER0 ? 1 : (requested ?? defaultShards),
  );

  const timings = await readTimings();
  let measuredSeconds = 0;
  let measuredBytes = 0;
  for (const file of selected) {
    if (timings[file] === undefined) continue;
    measuredSeconds += timings[file];
    measuredBytes += Bun.file(join(ROOT, file)).size;
  }
  const secondsPerByte = measuredBytes > 0 ? measuredSeconds / measuredBytes : 1 / 2000;
  const shards = deal(
    selected,
    shardCount,
    (file) => timings[file] ?? Bun.file(join(ROOT, file)).size * secondsPerByte,
  ).filter((shard) => shard.length > 0);

  mkdirSync(CACHE_DIR, { recursive: true });
  const ownsReporter = !options.forwarded.some((arg) => arg.startsWith("--reporter"));
  const live = shards.length === 1;
  const started = performance.now();
  if (!live) {
    console.log(
      `${selected.length} test files in ${shards.length} processes (tier ${TIER0 ? 0 : 3})…`,
    );
  }

  const results = await Promise.all(
    shards.map(async (shardFiles, i): Promise<ShardResult & { junit: string }> => {
      const index = i + 1;
      const junit = join(CACHE_DIR, `junit-${process.pid}-${index}.xml`);
      const cmd = [
        // The runner's own binary, so a run started under a pinned Bun
        // (`bunx bun@<version> scripts/run-tests.ts`) tests under that Bun.
        process.execPath,
        "test",
        ...(live ? options.forwarded : withCoverageDir(options.forwarded, index)),
        ...(ownsReporter ? ["--reporter=junit", `--reporter-outfile=${junit}`] : []),
        ...shardFiles.map((file) => `./${file}`),
      ];
      const proc = Bun.spawn(cmd, {
        cwd: ROOT,
        env: process.env,
        stdin: "ignore",
        stdout: live ? "inherit" : "pipe",
        stderr: live ? "inherit" : "pipe",
      });
      const output = live
        ? ""
        : (
            await Promise.all([
              new Response(proc.stdout as ReadableStream).text(),
              new Response(proc.stderr as ReadableStream).text(),
            ])
          )
            .join("\n")
            .replace(ANSI, "");
      const exitCode = await proc.exited;
      const seconds = (performance.now() - started) / 1000;
      if (!live) {
        const c = counts(output);
        console.log(
          `\n════ process ${index}/${shards.length} — ${shardFiles.length} files, ${seconds.toFixed(0)} s, ` +
            `exit ${exitCode} ════\n${output.trimEnd()}`,
        );
        console.error(
          `${exitCode === 0 ? "✓" : "✗"} process ${index}/${shards.length} done: ` +
            `${c.pass ?? 0} pass, ${c.fail ?? 0} fail (${seconds.toFixed(0)} s)`,
        );
      }
      return { index, files: shardFiles.length, exitCode, seconds, output, junit };
    }),
  );

  if (ownsReporter) {
    for (const { junit } of results) {
      for (const [file, seconds] of await junitTimings(junit)) timings[file] = seconds;
      rmSync(junit, { force: true });
    }
    await Bun.write(TIMINGS_FILE, JSON.stringify(timings));
  }

  const failed = results.filter((r) => r.exitCode !== 0);
  if (!live) {
    const total = counts(results.map((r) => r.output).join("\n"));
    const failures = results.flatMap((r) =>
      r.output.split("\n").filter((line) => line.startsWith("(fail)")),
    );
    const wall = ((performance.now() - started) / 1000).toFixed(0);
    console.log(
      `\n════ ${selected.length} files, ${shards.length} processes, ${wall} s ════\n` +
        ` ${total.pass ?? 0} pass\n ${total.skip ?? 0} skip\n ${total.fail ?? 0} fail\n` +
        (total.errors ? ` ${total.errors} errors\n` : "") +
        (failures.length ? `\n${failures.join("\n")}\n` : "") +
        (failed.length
          ? `\nFailed processes: ${failed.map((r) => `${r.index} (exit ${r.exitCode})`).join(", ")}`
          : ""),
    );
  }
  return failed.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(await main());
