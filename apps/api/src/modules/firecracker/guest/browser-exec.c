// SPDX-License-Identifier: Apache-2.0
//
// Fixed-target Firecracker browser worker launcher. The setuid-root binary is
// executable only by the sidecar uid, accepts one bounded platform slot, drops
// to the matching browser uid, and can execute only the baked first-party
// worker. Package-controlled argv never reaches this wrapper.

#define _GNU_SOURCE

#include <errno.h>
#include <grp.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/prctl.h>
#include <unistd.h>

#define BROWSER_WORKER "/usr/local/bin/appstrate-browser-worker"
#define BROWSER_UID_BASE 1101
#define BROWSER_SLOT_STRIDE 2
#define BROWSER_MAX_SLOTS 4

int main(int argc, char **argv) {
  if (argc != 2) {
    fprintf(stderr, "usage: appstrate-browser-exec <slot>\n");
    return 2;
  }
  char *end = NULL;
  errno = 0;
  long slot = strtol(argv[1], &end, 10);
  if (errno != 0 || end == argv[1] || *end != '\0' || slot < 0 || slot >= BROWSER_MAX_SLOTS) {
    fprintf(stderr, "appstrate-browser-exec: slot outside reserved range\n");
    return 126;
  }
  uid_t uid = BROWSER_UID_BASE + (uid_t)slot * BROWSER_SLOT_STRIDE;
  if (setgroups(0, NULL) != 0) {
    perror("appstrate-browser-exec: setgroups");
    return 126;
  }
  if (setgid(uid) != 0) {
    perror("appstrate-browser-exec: setgid");
    return 126;
  }
  if (setuid(uid) != 0) {
    perror("appstrate-browser-exec: setuid");
    return 126;
  }
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
    perror("appstrate-browser-exec: prctl(no_new_privs)");
    return 126;
  }
  char *const worker_argv[] = {(char *)BROWSER_WORKER, NULL};
  execv(BROWSER_WORKER, worker_argv);
  perror("appstrate-browser-exec: execv");
  return 127;
}
