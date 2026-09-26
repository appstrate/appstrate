// SPDX-License-Identifier: Apache-2.0
//
// appstrate-runner-exec — fixed-target privilege-drop wrapper for the
// Firecracker guest. Installed setuid-root, mode 4750 root:1000, so ONLY
// the sidecar (uid 1000) can exec it.
//
//   appstrate-runner-exec [--workspace] <uid> <command> [args...]
//
// It drops to <uid> — one uid of the runner pool, allocated by the sidecar
// per spawned integration runner — with that pool user's private group
// (gid == uid) as primary group, sets HOME to its 0700 home, umask 007 and
// no_new_privs, and execs the integration MCP server command. The only
// supplementary group is `workspace` (1003), and only with --workspace (the
// integration opted into /workspace); otherwise there is none.
//
// One uid and one group per runner lets the kernel attribute every socket
// to exactly one runner (the sidecar enforces per-runner egress on that
// attribution) and keeps each runner's HOME, files and /proc/<pid>/environ
// (decrypted credentials) out of its siblings' and the agent's reach (0700
// home, umask 007 on a private group, hidepid=2) — and the sidecar's
// environ out of every runner's.
//
// This is not a generic su: <uid> must fall inside the fixed pool and name a
// passwd entry with a private group, so the only possible transition is
// "become one unprivileged runner uid". The pool bounds mirror firewall.ts
// (GUEST_RUNNER_UID_FIRST/COUNT) — pinned by
// test/unit/runner-uid-contract.test.ts.
//
// Built statically in apps/api/src/modules/firecracker/scripts/Dockerfile.rootfs and installed
// AFTER the rootfs-wide setuid strip (it is the one intentional setuid).

#define _GNU_SOURCE

#include <grp.h>
#include <pwd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <unistd.h>

#define RUNNER_UID_FIRST 1100
#define RUNNER_UID_COUNT 64
#define WORKSPACE_GID 1003

// Strict decimal parse into the pool: digits only (no sign, whitespace or
// trailing junk), bounded while accumulating so it cannot overflow.
static int parse_pool_uid(const char *s, uid_t *out) {
  unsigned long v = 0;
  if (*s == '\0') return -1;
  for (; *s != '\0'; s++) {
    if (*s < '0' || *s > '9') return -1;
    v = v * 10 + (unsigned long)(*s - '0');
    if (v >= RUNNER_UID_FIRST + RUNNER_UID_COUNT) return -1;
  }
  if (v < RUNNER_UID_FIRST) return -1;
  *out = (uid_t)v;
  return 0;
}

int main(int argc, char **argv) {
  const int workspace = argc > 1 && strcmp(argv[1], "--workspace") == 0;
  char **args = argv + 1 + workspace;
  if (argc - 1 - workspace < 2) {
    fprintf(stderr, "usage: appstrate-runner-exec [--workspace] <uid> <command> [args...]\n");
    return 2;
  }
  uid_t uid;
  if (parse_pool_uid(args[0], &uid) != 0) {
    fprintf(stderr, "appstrate-runner-exec: uid must be a decimal in [%d, %d]\n",
            RUNNER_UID_FIRST, RUNNER_UID_FIRST + RUNNER_UID_COUNT - 1);
    return 2;
  }
  const struct passwd *pw = getpwuid(uid);
  if (pw == NULL || pw->pw_gid != (gid_t)uid) {
    fprintf(stderr, "appstrate-runner-exec: uid %u has no pool user with a private group\n",
            (unsigned)uid);
    return 2;
  }
  // Supplementary groups first (needs privilege), then gid, then uid —
  // the reverse order would drop the privilege needed for the earlier
  // steps.
  const gid_t workspace_gid = WORKSPACE_GID;
  if (setgroups(workspace ? 1 : 0, workspace ? &workspace_gid : NULL) != 0) {
    perror("appstrate-runner-exec: setgroups");
    return 126;
  }
  if (setgid(pw->pw_gid) != 0) {
    perror("appstrate-runner-exec: setgid");
    return 126;
  }
  if (setuid(uid) != 0) {
    perror("appstrate-runner-exec: setuid");
    return 126;
  }
  // setuid from euid 0 sets real, effective and saved uid: regaining root
  // must now be impossible.
  if (setuid(0) == 0) {
    fprintf(stderr, "appstrate-runner-exec: privilege drop is reversible\n");
    return 126;
  }
  // Owner + group only: the group is private, except in the setgid
  // /workspace where it is `workspace` (shared with the agent on purpose).
  umask(007);
  if (setenv("HOME", pw->pw_dir, 1) != 0) {
    perror("appstrate-runner-exec: setenv(HOME)");
    return 126;
  }
  // The runner must never re-escalate through another setuid exec.
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
    perror("appstrate-runner-exec: prctl(no_new_privs)");
    return 126;
  }
  execvp(args[1], &args[1]);
  perror("appstrate-runner-exec: execvp");
  return 127;
}
