// SPDX-License-Identifier: Apache-2.0
//
// appstrate-runner-exec — fixed-target privilege-drop wrapper for the
// Firecracker guest. Installed setuid-root, mode 4750 root:1000, so ONLY
// the sidecar (uid 1000) can exec it. It drops to the dedicated runner
// user (uid/gid 1002), sets no_new_privs, and execs the integration MCP
// server command. This gives in-guest integration runners their own uid —
// the sidecar's /proc/<pid>/environ (RUN_TOKEN, LLM/OAuth credentials)
// stays unreadable to them (owner-only + hidepid=2).
//
// The target uid is HARDCODED: this is not a generic su. Even if an
// unexpected caller reached it, the only possible transition is "become
// the unprivileged runner user".
//
// Built statically in apps/api/src/modules/firecracker/scripts/Dockerfile.rootfs and installed
// AFTER the rootfs-wide setuid strip (it is the one intentional setuid).

#define _GNU_SOURCE

#include <grp.h>
#include <stdio.h>
#include <sys/prctl.h>
#include <unistd.h>

#define RUNNER_USER "runner"
#define RUNNER_UID 1002
#define RUNNER_GID 1002

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: appstrate-runner-exec <command> [args...]\n");
    return 2;
  }
  // Supplementary groups first (needs privilege), then gid, then uid —
  // the reverse order would drop the privilege needed for the earlier
  // steps. initgroups picks up the shared `workspace` group (1003).
  if (initgroups(RUNNER_USER, RUNNER_GID) != 0) {
    perror("appstrate-runner-exec: initgroups");
    return 126;
  }
  if (setgid(RUNNER_GID) != 0) {
    perror("appstrate-runner-exec: setgid");
    return 126;
  }
  if (setuid(RUNNER_UID) != 0) {
    perror("appstrate-runner-exec: setuid");
    return 126;
  }
  // The runner must never re-escalate through another setuid exec.
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
    perror("appstrate-runner-exec: prctl(no_new_privs)");
    return 126;
  }
  execvp(argv[1], &argv[1]);
  perror("appstrate-runner-exec: execvp");
  return 127;
}
