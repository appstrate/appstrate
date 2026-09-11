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
 * The fixture wrapper does NOT drop privilege — it is `exec "$@"`, so the
 * runner still runs as the test process. That is deliberate and safe
 * here: these tests assert env propagation, stderr relay, and MCP
 * round-trips, never isolation. It stands in for the supervisor's setuid
 * wrapper so the argv-forwarding path (`wrapper <interpreter> <entry>`)
 * is exercised exactly as in the guest.
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

export interface PassthroughRunnerExec {
  /** Absolute path of the wrapper script now on `APPSTRATE_RUNNER_EXEC`. */
  path: string;
  /** Restore the previous env value and delete the wrapper. */
  restore(): Promise<void>;
}

export async function installPassthroughRunnerExec(): Promise<PassthroughRunnerExec> {
  const dir = await mkdtemp(join(tmpdir(), "appstrate-runner-exec-"));
  const path = join(dir, "runner-exec");
  await writeFile(path, '#!/bin/sh\nexec "$@"\n');
  await Bun.spawn(["chmod", "4755", path], { stdout: "ignore", stderr: "ignore" }).exited;
  if (((await stat(path)).mode & 0o4000) === 0) {
    throw new Error(`runner-exec fixture: could not set the setuid bit on ${path}`);
  }
  const previous = process.env.APPSTRATE_RUNNER_EXEC;
  process.env.APPSTRATE_RUNNER_EXEC = path;
  return {
    path,
    async restore() {
      if (previous === undefined) delete process.env.APPSTRATE_RUNNER_EXEC;
      else process.env.APPSTRATE_RUNNER_EXEC = previous;
      await rm(dir, { recursive: true, force: true });
    },
  };
}
