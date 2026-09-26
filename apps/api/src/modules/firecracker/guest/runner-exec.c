// SPDX-License-Identifier: Apache-2.0
//
// appstrate-runner-exec — fixed-target privilege-drop wrapper for the
// Firecracker guest. Installed setuid-root, mode 4750 root:1000, so ONLY
// the sidecar (uid 1000) can exec it.
//
//   appstrate-runner-exec <uid> <command> [args...]
//
// It drops to <uid> — one uid of the runner pool, allocated by the sidecar
// per spawned integration runner — with primary group `runner` (1002) and
// the single supplementary group `workspace` (1003), sets no_new_privs, and
// execs the integration MCP server command. One uid per runner lets the
// kernel attribute every socket to exactly one runner (the sidecar enforces
// per-runner egress on that attribution) and keeps each runner's
// /proc/<pid>/environ (decrypted credentials) unreadable to its siblings and
// the sidecar's unreadable to all of them (owner-only + hidepid=2).
//
// This is not a generic su: <uid> must fall inside the fixed pool, so the
// only possible transition is "become one unprivileged runner uid". The
// pool bounds mirror firewall.ts (GUEST_RUNNER_UID_FIRST/COUNT) — pinned by
// test/unit/runner-uid-contract.test.ts.
//
// Built statically in apps/api/src/modules/firecracker/scripts/Dockerfile.rootfs and installed
// AFTER the rootfs-wide setuid strip (it is the one intentional setuid).

#define _GNU_SOURCE

#include <grp.h>
#include <stdio.h>
#include <sys/prctl.h>
#include <unistd.h>

#define RUNNER_UID_FIRST 1100
#define RUNNER_UID_COUNT 64
#define RUNNER_GID 1002
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
  if (argc < 3) {
    fprintf(stderr, "usage: appstrate-runner-exec <uid> <command> [args...]\n");
    return 2;
  }
  uid_t uid;
  if (parse_pool_uid(argv[1], &uid) != 0) {
    fprintf(stderr, "appstrate-runner-exec: uid must be a decimal in [%d, %d]\n",
            RUNNER_UID_FIRST, RUNNER_UID_FIRST + RUNNER_UID_COUNT - 1);
    return 2;
  }
  // Supplementary groups first (needs privilege), then gid, then uid —
  // the reverse order would drop the privilege needed for the earlier
  // steps.
  const gid_t groups[] = {WORKSPACE_GID};
  if (setgroups(1, groups) != 0) {
    perror("appstrate-runner-exec: setgroups");
    return 126;
  }
  if (setgid(RUNNER_GID) != 0) {
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
  // The runner must never re-escalate through another setuid exec.
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
    perror("appstrate-runner-exec: prctl(no_new_privs)");
    return 126;
  }
  execvp(argv[2], &argv[2]);
  perror("appstrate-runner-exec: execvp");
  return 127;
}
