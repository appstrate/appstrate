// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the host page-cache warmer (runner/readahead.ts).
 *
 * The warmer is best-effort by contract: it must read every existing
 * artifact end-to-end (that read IS the cache warm) and must never throw,
 * whatever the filesystem does. Real temp files are used — the unit under
 * test is literally "sequentially read this path".
 */

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { warmHostPageCache } from "../../runner/readahead.ts";
import type { Logger } from "@appstrate/core/logger";

const dir = await mkdtemp(join(tmpdir(), "fc-readahead-"));
afterAll(() => rm(dir, { recursive: true, force: true }));

function captureLogger(): { logger: Logger; infos: unknown[]; warns: unknown[] } {
  const infos: unknown[] = [];
  const warns: unknown[] = [];
  const logger = {
    info: (_msg: string, fields?: unknown) => void infos.push(fields),
    warn: (_msg: string, fields?: unknown) => void warns.push(fields),
    error: () => {},
    debug: () => {},
  } as unknown as Logger;
  return { logger, infos, warns };
}

describe("warmHostPageCache", () => {
  it("reads each artifact fully and logs its size", async () => {
    const rootfs = join(dir, "rootfs.ext4");
    const kernel = join(dir, "vmlinux");
    // Larger than one 8 MiB chunk so the multi-chunk stream path runs.
    await writeFile(rootfs, new Uint8Array(9 * 1024 * 1024));
    await writeFile(kernel, new Uint8Array(1024));

    const { logger, infos, warns } = captureLogger();
    await warmHostPageCache([rootfs, kernel], { logger });

    expect(warns).toHaveLength(0);
    expect(infos).toHaveLength(2);
    expect(infos[0]).toMatchObject({ path: rootfs, mib: 9 });
    expect(infos[1]).toMatchObject({ path: kernel, mib: 0 });
  });

  it("warns and continues past a missing file — never throws", async () => {
    const present = join(dir, "present.ext4");
    await writeFile(present, new Uint8Array(64));

    const { logger, infos, warns } = captureLogger();
    await warmHostPageCache([join(dir, "absent.ext4"), present], { logger });

    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({ path: join(dir, "absent.ext4") });
    // The failure did not short-circuit the remaining artifacts.
    expect(infos).toHaveLength(1);
    expect(infos[0]).toMatchObject({ path: present });
  });
});
