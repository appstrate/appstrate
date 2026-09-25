// SPDX-License-Identifier: Apache-2.0

/**
 * The agent runtime's first process: `bun launcher.js <entrypoint>`.
 *
 * It is the only process that ever holds the run-scoped secrets in its
 * environment. It makes itself non-dumpable, starts the entrypoint with an
 * explicit environment that excludes them, hands them over on the
 * entrypoint's stdin (`@appstrate/runner-pi/secret-env`), forwards
 * SIGTERM/SIGINT and exits with the entrypoint's status. As PID 1 it also
 * reaps the processes the agent orphans (`reap-orphans.ts`). Nothing else.
 */

import { writeSync } from "node:fs";
import { constants } from "node:os";
import { splitSecretEnv } from "@appstrate/runner-pi/secret-env";
import { makeProcessNonDumpable } from "./non-dumpable.ts";
import { startOrphanReaper } from "./reap-orphans.ts";

const entrypoint = process.argv[2];
try {
  if (!entrypoint) throw new Error("usage: launcher <entrypoint>");
  makeProcessNonDumpable();
} catch (err) {
  writeSync(2, `[runtime-pi launcher] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}

const { env, payload } = splitSecretEnv(process.env);
const child = Bun.spawn([process.execPath, entrypoint], {
  env,
  stdin: "pipe",
  stdout: "inherit",
  stderr: "inherit",
});
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => child.kill(signal));
const stopReaper = startOrphanReaper(child.pid);

try {
  await child.stdin.write(payload);
  await child.stdin.end();
} catch {
  // The entrypoint died before reading; its exit status below says why.
}

await child.exited;
stopReaper();
process.exit(child.exitCode ?? 128 + (constants.signals[child.signalCode!] ?? 9));
