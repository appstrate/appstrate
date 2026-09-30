// SPDX-License-Identifier: Apache-2.0

/**
 * Run a snippet in a child `bun` process that owns its own stdout/stderr.
 *
 * Used by the byte-for-byte comparisons in `io.test.ts` and `ui.test.ts`:
 * `DEFAULT_IO` and the clack wrappers write to the *real* process streams by
 * definition, and observing them is the one thing those tests must not do by
 * reassigning this process's streams — that is the pattern issue #1180
 * retires. A child owns a buffer no other suite can write to.
 */

import { join } from "node:path";

/**
 * The CLI package root (`apps/cli`), two levels up from `test/helpers/`.
 *
 * Pinned as the child's `cwd` because bare specifiers resolve against it:
 * `@clack/prompts` lives in `apps/cli/node_modules` and is not hoisted to the
 * workspace root. A child inherits the *parent's* cwd, which differs per CI
 * job — the Unit job runs `bun test` with `working-directory: apps/cli`, the
 * Integration job runs it from the repo root — so without this pin the child
 * dies with "Cannot find module '@clack/prompts'" from the root and writes
 * nothing at all. Absolute paths handed to the snippet resolve either way; it
 * is the bare specifiers, in the snippet and inside the modules it imports,
 * that need a cwd they can count on.
 */
const CLI_ROOT = join(import.meta.dir, "..", "..");

export async function runIsolated(code: string) {
  const proc = Bun.spawn([process.execPath, "-e", code], {
    cwd: CLI_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

/**
 * Run the real `src/cli.ts` in a child: it parses `process.argv` at import, so
 * its commander wiring can only be observed from outside. `home` holds `HOME`,
 * config and data, and the environment is otherwise empty.
 */
export async function runCli(home: string, ...args: string[]) {
  const proc = Bun.spawn([process.execPath, "src/cli.ts", ...args], {
    cwd: CLI_ROOT,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_DATA_HOME: join(home, "data"),
      APPSTRATE_NO_DUAL_INSTALL_CHECK: "1",
      NO_COLOR: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}
