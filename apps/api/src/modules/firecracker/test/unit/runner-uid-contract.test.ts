// SPDX-License-Identifier: Apache-2.0

/**
 * The integration runner uid pool is declared in three places that cannot
 * import each other: firewall.ts (the firewall rule + the sidecar's
 * APPSTRATE_RUNNER_UIDS), the setuid runner-exec wrapper (the only uids it
 * will drop to) and the rootfs Dockerfile (the passwd entries). A drift
 * would let the wrapper hand out a uid the firewall does not know, or one
 * without a passwd entry — so the three are pinned together here.
 */

import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import {
  GUEST_RUNNER_UID_COUNT,
  GUEST_RUNNER_UID_FIRST,
  GUEST_RUNNER_UIDS,
} from "../../guest/firewall.ts";

const MODULE_DIR = join(import.meta.dir, "..", "..");
const wrapperSource = await Bun.file(join(MODULE_DIR, "guest", "runner-exec.c")).text();
const dockerfile = await Bun.file(join(MODULE_DIR, "scripts", "Dockerfile.rootfs")).text();

function capture(source: string, pattern: RegExp): number {
  const match = source.match(pattern);
  if (!match?.[1]) throw new Error(`pattern not found: ${pattern}`);
  return Number(match[1]);
}

const cDefine = (name: string) =>
  capture(wrapperSource, new RegExp(`^#define ${name} (\\d+)$`, "m"));

describe("runner uid pool contract", () => {
  it("derives the range string from first + count", () => {
    expect(GUEST_RUNNER_UIDS).toBe(
      `${GUEST_RUNNER_UID_FIRST}-${GUEST_RUNNER_UID_FIRST + GUEST_RUNNER_UID_COUNT - 1}`,
    );
  });

  it("runner-exec.c accepts exactly the firewall.ts pool", () => {
    expect(cDefine("RUNNER_UID_FIRST")).toBe(GUEST_RUNNER_UID_FIRST);
    expect(cDefine("RUNNER_UID_COUNT")).toBe(GUEST_RUNNER_UID_COUNT);
  });

  it("runner-exec.c drops to the runner and workspace groups", () => {
    expect(cDefine("RUNNER_GID")).toBe(1002);
    expect(cDefine("WORKSPACE_GID")).toBe(1003);
  });

  it("Dockerfile.rootfs bakes a passwd entry for every pool uid", () => {
    expect(capture(dockerfile, /for i in \$\(seq 0 (\d+)\)/)).toBe(GUEST_RUNNER_UID_COUNT - 1);
    expect(capture(dockerfile, /-u "\$\(\((\d+) \+ i\)\)"/)).toBe(GUEST_RUNNER_UID_FIRST);
  });

  it("Dockerfile.rootfs creates the groups the wrapper drops to", () => {
    expect(capture(dockerfile, /addgroup -g (\d+) runner\b/)).toBe(1002);
    expect(capture(dockerfile, /addgroup -g (\d+) workspace\b/)).toBe(1003);
  });
});
