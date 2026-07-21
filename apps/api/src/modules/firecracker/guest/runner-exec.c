// SPDX-License-Identifier: Apache-2.0
//
// appstrate-runner-exec — fixed-target privilege-drop wrapper for the
// Firecracker guest. Installed setuid-root, mode 4750 root:1000, so ONLY
// the sidecar (uid 1000) can exec it. It drops to the dedicated runner
// user (uid/gid 1002), or to a platform-assigned browser-driver slot in the
// reserved uid range, sets no_new_privs, and execs the integration MCP server
// command. Browser packages cannot select an arbitrary uid: only slots 0..3
// are accepted and the trusted sidecar supplies the normalized slot.
// the sidecar's /proc/<pid>/environ (RUN_TOKEN, LLM/OAuth credentials)
// stays unreadable to them (owner-only + hidepid=2).
//
// Target uids are HARDCODED: this is not a generic su. Even if an unexpected
// caller reached it, the only possible transitions are the ordinary runner or
// one of the four reserved unprivileged browser-driver identities.
//
// Built statically in apps/api/src/modules/firecracker/scripts/Dockerfile.rootfs and installed
// AFTER the rootfs-wide setuid strip (one of two intentional setuid wrappers).

#define _GNU_SOURCE

#include <grp.h>
#include <errno.h>
#include <stdlib.h>
#include <stdio.h>
#include <sys/prctl.h>
#include <unistd.h>

#define RUNNER_USER "runner"
#define RUNNER_UID 1002
#define RUNNER_GID 1002
#define WORKSPACE_GID 1003
#define BROWSER_DRIVER_UID_BASE 1100
#define BROWSER_SLOT_STRIDE 2
#define BROWSER_MAX_SLOTS 4

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: appstrate-runner-exec <command> [args...]\n");
    return 2;
  }
  uid_t target_uid = RUNNER_UID;
  gid_t target_gid = RUNNER_GID;
  int command_index = 1;
  int browser_slot = -1;
  if (argc >= 3) {
    char *end = NULL;
    errno = 0;
    long parsed = strtol(argv[1], &end, 10);
    if (errno == 0 && end != argv[1] && *end == '\0') {
      if (parsed < 0 || parsed >= BROWSER_MAX_SLOTS) {
        fprintf(stderr, "appstrate-runner-exec: browser slot outside reserved range\n");
        return 126;
      }
      browser_slot = (int)parsed;
      target_uid = BROWSER_DRIVER_UID_BASE + browser_slot * BROWSER_SLOT_STRIDE;
      target_gid = target_uid;
      command_index = 2;
    }
  }

  // Supplementary groups first (needs privilege), then gid, then uid —
  // the reverse order would drop the privilege needed for the earlier
  // steps. initgroups picks up the shared `workspace` group (1003).
  if (browser_slot >= 0) {
    gid_t groups[] = {WORKSPACE_GID};
    if (setgroups(1, groups) != 0) {
      perror("appstrate-runner-exec: setgroups");
      return 126;
    }
  } else {
    if (initgroups(RUNNER_USER, RUNNER_GID) != 0) {
      perror("appstrate-runner-exec: initgroups");
      return 126;
    }
  }
  if (setgid(target_gid) != 0) {
    perror("appstrate-runner-exec: setgid");
    return 126;
  }
  if (setuid(target_uid) != 0) {
    perror("appstrate-runner-exec: setuid");
    return 126;
  }
  // The runner must never re-escalate through another setuid exec.
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
    perror("appstrate-runner-exec: prctl(no_new_privs)");
    return 126;
  }
  execvp(argv[command_index], &argv[command_index]);
  perror("appstrate-runner-exec: execvp");
  return 127;
}
