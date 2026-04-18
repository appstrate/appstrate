// SPDX-License-Identifier: Apache-2.0

/**
 * Tier 0 bootstrap — `bun run dev` against a local checkout of
 * Appstrate. No Docker, no infra. Targets evaluators who want
 * Appstrate running in seconds without installing the production
 * stack.
 *
 * Bun is the only runtime dependency. If missing, we install it via
 * the official `curl https://bun.sh/install | bash` installer into
 * `~/.bun` — user-local, no sudo, signed by the upstream script. We
 * add `~/.bun/bin` to the PATH of the spawned dev process rather than
 * modifying the user's shell rc (idempotent, no side-effects beyond
 * the install dir + ~/.bun).
 *
 * Source acquisition uses `git clone --depth=1` against the release
 * tag matching the CLI's version. If git is absent on the host we
 * fall back to a tarball download — works on stripped container
 * images where git isn't provisioned. Either way we end up with a
 * fully populated monorepo in the install dir.
 */

import { mkdir, writeFile, access, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { commandExists, runCommand, waitForHttp } from "./os.ts";

/** Known location of the user-local Bun install produced by the upstream installer. */
export const BUN_HOME = join(homedir(), ".bun");
export const BUN_BIN = join(BUN_HOME, "bin");

export class GitMissingError extends Error {
  constructor() {
    super(
      "Neither `git` nor a working tarball fallback is available. Install git or re-run in an environment that has curl + tar on PATH.",
    );
    this.name = "GitMissingError";
  }
}

/** Check if `bun` is on PATH or in the user-local `~/.bun/bin`. */
export function detectBun(): { found: boolean; path: string | null } {
  if (commandExists("bun")) return { found: true, path: "bun" };
  const localPath = join(BUN_BIN, "bun");
  // Best effort — spawnSync stat would work but commandExists already
  // returned false, so try a direct probe via `access` would be async.
  // Return the local path optimistically; the caller can re-probe.
  return { found: false, path: localPath };
}

/**
 * Run the upstream Bun installer. Writes to `~/.bun`, no sudo. The
 * installer is a shell script that curls the latest release tarball
 * — we pipe it into `bash` directly without caching, mirroring the
 * documented install path.
 *
 * Note on `bash -c`: the command string is a string literal with zero
 * user-supplied substitution. There is no interpolation of any runtime
 * value into the shell command, so the shell-injection rules that
 * apply to `cloneAppstrateSource`'s tarball fallback do not apply
 * here. If that invariant ever changes, switch this to a tmp-file +
 * `bash <file>` pattern first.
 */
export async function installBun(): Promise<void> {
  const res = await runCommand("bash", ["-c", "curl -fsSL https://bun.sh/install | bash"], {
    stdio: "inherit",
  });
  if (!res.ok) {
    throw new Error(`Bun install failed with exit code ${res.exitCode}.`);
  }
  // Sanity-check: the installer should have produced the binary.
  try {
    await access(join(BUN_BIN, "bun"));
  } catch {
    throw new Error(
      `Bun installer reported success but ${BUN_BIN}/bun is missing. Re-run or install manually from https://bun.sh`,
    );
  }
}

export interface CloneSourceOptions {
  /** Semver-ish tag, e.g. `v1.2.3`. Falls back to `main` when undefined (dev). */
  version?: string;
  /** Override for tests so we don't actually clone github. */
  gitUrl?: string;
  /** Override for tests. */
  tarballUrl?: string;
}

const DEFAULT_GIT_URL = "https://github.com/appstrate/appstrate-oss.git";
const DEFAULT_TARBALL_BASE = "https://github.com/appstrate/appstrate-oss/archive/refs";

/**
 * Fetch the Appstrate source into `dir`. Tries `git clone --depth=1`
 * first (fast, reproducible via tag). Falls back to tarball +
 * `tar -xz --strip-components=1` if git isn't on PATH.
 *
 * `--depth=1` keeps the checkout minimal (no history) — Tier 0 users
 * don't need git history, just the working tree.
 */
export async function cloneAppstrateSource(
  dir: string,
  opts: CloneSourceOptions = {},
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const tagRef = opts.version ? `tags/${opts.version}` : "heads/main";
  const refSpec = opts.version ? `--branch=${opts.version}` : "--branch=main";
  const gitUrl = opts.gitUrl ?? DEFAULT_GIT_URL;

  if (commandExists("git")) {
    const res = await runCommand("git", ["clone", "--depth=1", refSpec, gitUrl, dir], {
      stdio: "inherit",
    });
    if (res.ok) return;
    // Git present but the clone failed — re-throw rather than silently
    // degrading to the tarball path (likely a network / repo issue
    // that tarball won't fix either).
    throw new Error(`git clone failed: ${res.stderr || `exit ${res.exitCode}`}`);
  }

  // git missing — tarball fallback.
  const tarballUrl = opts.tarballUrl ?? `${DEFAULT_TARBALL_BASE}/${tagRef}.tar.gz`;
  if (!commandExists("curl") || !commandExists("tar")) throw new GitMissingError();

  // Two distinct spawns instead of `bash -c "curl … | tar … -C <dir>"`.
  // The shell-piped form interpolated the user-supplied `dir` inside
  // the bash `-c` string, which meant a dir containing `;`, backticks,
  // `$(...)`, or newlines would run arbitrary code. We now spawn `curl`
  // and `tar` directly with `dir` as a positional argv — neither tool
  // interprets shell metacharacters in arguments.
  const tmpTarball = join(dir, ".appstrate-source.tar.gz");
  const dl = await runCommand("curl", ["-fsSL", "-o", tmpTarball, tarballUrl], {
    stdio: "inherit",
  });
  if (!dl.ok) {
    await unlink(tmpTarball).catch(() => {});
    throw new Error(`Tarball download failed: ${dl.stderr || `exit ${dl.exitCode}`}`);
  }
  const ex = await runCommand("tar", ["-xzf", tmpTarball, "--strip-components=1", "-C", dir], {
    stdio: "inherit",
  });
  await unlink(tmpTarball).catch(() => {});
  if (!ex.ok) {
    throw new Error(`Tarball extraction failed: ${ex.stderr || `exit ${ex.exitCode}`}`);
  }
}

/** Run `bun install` in the clone. Uses the user-local bun if PATH bun is absent. */
export async function runBunInstall(dir: string, bunPath: string): Promise<void> {
  const res = await runCommand(bunPath, ["install"], { cwd: dir, stdio: "inherit" });
  if (!res.ok) {
    throw new Error(`bun install failed with exit code ${res.exitCode}`);
  }
}

/** Write `.env` into the cloned directory with 0600. */
export async function writeEnvFile(dir: string, envFileBody: string): Promise<void> {
  await writeFile(join(dir, ".env"), envFileBody, { mode: 0o600 });
}

/**
 * Spawn `bun run dev` in the background and resolve once the
 * healthcheck at `<appUrl>/` succeeds. Detaches the child so
 * control returns to the terminal — the user stops it with Ctrl-C
 * on the returned process, or by killing it via the printed PID.
 */
export async function spawnDevServer(
  dir: string,
  bunPath: string,
  appUrl: string,
  timeoutMs = 60_000,
): Promise<{ pid: number }> {
  const env = {
    ...process.env,
    // Prepend user-local Bun to PATH so `bun run dev`'s own scripts
    // resolve `bun` consistently even when it was just installed.
    PATH: `${BUN_BIN}:${process.env.PATH ?? ""}`,
  };
  const child = spawn(bunPath, ["run", "dev"], {
    cwd: dir,
    env,
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  const ok = await waitForHttp(appUrl, timeoutMs);
  if (!ok) {
    throw new Error(
      `Dev server did not become healthy within ${Math.round(timeoutMs / 1000)}s — check the install dir for logs or run \`bun run dev\` manually.`,
    );
  }
  if (!child.pid) {
    throw new Error("Dev server was launched but the child process reported no PID.");
  }
  return { pid: child.pid };
}
