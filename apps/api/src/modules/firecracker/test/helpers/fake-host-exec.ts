// SPDX-License-Identifier: Apache-2.0

/**
 * Shared fake {@link HostExec} for the Firecracker unit tests. A recording
 * stub the host-command-driven code paths run against with no CAP_NET_ADMIN,
 * no netns, and no network — every test that needs one rebuilt this inline.
 */

import type { HostExec } from "../../host-net.ts";

/** A single recorded HostExec invocation (argv + optional stdin). */
export interface RecordedCall {
  cmd: string[];
  stdin?: string;
}

/** All host commands succeed; `ip -j link show` reports no TAP devices. */
export function defaultRespond(cmd: string[]): string {
  return cmd.join(" ") === "ip -j link show" ? "[]" : "";
}

/**
 * Fake HostExec that records every command. `respond` maps an argv to its
 * stdout, or to an Error to simulate a non-zero exit (thrown, exactly like
 * the real executor). Defaults to {@link defaultRespond}.
 */
export function fakeHostExec(respond: (cmd: string[]) => string | Error = defaultRespond): {
  exec: HostExec;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  return {
    calls,
    exec: {
      async run(cmd, opts) {
        calls.push({ cmd, ...(opts?.stdin !== undefined ? { stdin: opts.stdin } : {}) });
        const result = respond(cmd);
        if (result instanceof Error) throw result;
        return result;
      },
    },
  };
}
