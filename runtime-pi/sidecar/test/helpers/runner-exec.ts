// SPDX-License-Identifier: Apache-2.0

/**
 * Test stand-in for the Firecracker guest supervisor's privilege-drop
 * wrapper.
 *
 * The process adapter refuses to spawn a `source.kind: "local"` runner
 * unless `APPSTRATE_RUNNER_EXEC` names a wrapper that can land the child
 * on a different uid (see `integration-runtime-adapter-process.ts`). Any
 * test that wants a REAL host subprocess therefore has to supply one.
 *
 * The fixture wrapper does NOT drop privilege — it hands its uid argument
 * to the runner as {@link FIXTURE_UID_ENV} (and an optional leading
 * `--workspace` as {@link FIXTURE_WORKSPACE_ENV}) and `exec "$@"`s the rest,
 * so the runner still runs as the test process. That is
 * deliberate and safe here: these tests assert env propagation, stderr
 * relay, and MCP round-trips, never isolation. It stands in for the
 * supervisor's setuid wrapper so the argv-forwarding path
 * (`wrapper [--workspace] <uid> <interpreter> <entry>`) is exercised exactly
 * as in the guest, and it installs the runner uid pool the adapter also
 * requires.
 *
 * It DOES carry the setuid bit, because the adapter now stats for it (a
 * wrapper without one cannot change the child's uid, so it is refused). The
 * bit is set through the `chmod` CLI: Bun's `fs.chmod` silently masks off
 * every bit above 0o777, so `chmod(path, 0o4755)` lands as 0755 and the
 * fixture would be refused. Setting it is enough — the kernel ignores setuid
 * on `#!` scripts anyway, and nothing here depends on an actual uid change.
 */

import { mkdtemp, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The runner uid pool the fixture installs on `APPSTRATE_RUNNER_UIDS`. */
export const FIXTURE_RUNNER_UIDS = { first: 1100, last: 1163 } as const;

/** Env var through which the fixture wrapper shows the runner the uid it was handed. */
export const FIXTURE_UID_ENV = "APPSTRATE_FIXTURE_RUNNER_UID";

/** Set to `"1"` by the fixture wrapper when it was handed `--workspace`. */
export const FIXTURE_WORKSPACE_ENV = "APPSTRATE_FIXTURE_RUNNER_WORKSPACE";

export interface PassthroughRunnerExec {
  /** Absolute path of the wrapper script now on `APPSTRATE_RUNNER_EXEC`. */
  path: string;
  /** Restore the previous env values and delete the wrapper. */
  restore(): Promise<void>;
}

export async function installPassthroughRunnerExec(): Promise<PassthroughRunnerExec> {
  const dir = await mkdtemp(join(tmpdir(), "appstrate-runner-exec-"));
  const path = join(dir, "runner-exec");
  await writeFile(
    path,
    [
      "#!/bin/sh",
      `if [ "$1" = "--workspace" ]; then ${FIXTURE_WORKSPACE_ENV}=1; export ${FIXTURE_WORKSPACE_ENV}; shift; fi`,
      `${FIXTURE_UID_ENV}="$1"`,
      `export ${FIXTURE_UID_ENV}`,
      "shift",
      'exec "$@"',
      "",
    ].join("\n"),
  );
  await Bun.spawn(["chmod", "4755", path], { stdout: "ignore", stderr: "ignore" }).exited;
  if (((await stat(path)).mode & 0o4000) === 0) {
    throw new Error(`runner-exec fixture: could not set the setuid bit on ${path}`);
  }
  const previous = {
    APPSTRATE_RUNNER_EXEC: process.env.APPSTRATE_RUNNER_EXEC,
    APPSTRATE_RUNNER_UIDS: process.env.APPSTRATE_RUNNER_UIDS,
  };
  process.env.APPSTRATE_RUNNER_EXEC = path;
  process.env.APPSTRATE_RUNNER_UIDS = `${FIXTURE_RUNNER_UIDS.first}-${FIXTURE_RUNNER_UIDS.last}`;
  return {
    path,
    async restore() {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(dir, { recursive: true, force: true });
    },
  };
}
