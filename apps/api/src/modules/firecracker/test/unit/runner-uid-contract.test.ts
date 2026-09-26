// SPDX-License-Identifier: Apache-2.0

/**
 * The integration runner uid pool is declared in three places that cannot
 * import each other: firewall.ts (the firewall rule + the sidecar's
 * APPSTRATE_RUNNER_UIDS), the setuid runner-exec wrapper (the only uids it
 * will drop to) and the rootfs Dockerfile (the passwd entries). A drift
 * would let the wrapper hand out a uid the firewall does not know, or one
 * without a passwd entry and private group (the wrapper refuses it) — so the
 * three are pinned together here, along with the group layout: a private
 * group per runner, `workspace` only through the wrapper's --workspace.
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

  it("runner-exec.c grants only the workspace group, and no shared runner group", () => {
    expect(cDefine("WORKSPACE_GID")).toBe(1003);
    expect(wrapperSource).not.toMatch(/RUNNER_GID/);
  });

  it("Dockerfile.rootfs bakes each pool uid a private group and a 0700 home", () => {
    const upgGroup = /addgroup -g "\$\(\((\d+) \+ i\)\)" "runner\$i"/;
    const upgUser = /adduser -D -u "\$\(\((\d+) \+ i\)\)" -G "runner\$i" /;
    expect(capture(dockerfile, /for i in \$\(seq 0 (\d+)\)/)).toBe(GUEST_RUNNER_UID_COUNT - 1);
    expect(capture(dockerfile, upgGroup)).toBe(GUEST_RUNNER_UID_FIRST);
    expect(capture(dockerfile, upgUser)).toBe(GUEST_RUNNER_UID_FIRST);
    expect(dockerfile).toMatch(/chmod 700 "\/home\/runner\$i"/);
  });

  it("Dockerfile.rootfs creates the workspace group and no shared runner group", () => {
    expect(capture(dockerfile, /addgroup -g (\d+) workspace\b/)).toBe(1003);
    expect(dockerfile).not.toMatch(/addgroup -g 1002\b|addgroup "runner\$i" workspace/);
  });
});
