// SPDX-License-Identifier: Apache-2.0

/**
 * Host page-cache warmer for the guest boot artifacts (issue #835).
 *
 * Firecracker reads `rootfs.ext4` / `vmlinux` with buffered I/O, so once the
 * host page cache is warm every guest virtio-blk read is served from host
 * RAM. The cache is naturally warm right after the artifact resolver
 * downloads a fresh file — but cold after a host reboot or an eviction, and
 * the FIRST run then pays disk latency for the whole boot read set. A single
 * sequential read at daemon boot moves that cost off the run path.
 *
 * Strictly best-effort instrumentation-grade code: any failure is a warning,
 * never a boot blocker.
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { Logger } from "@appstrate/core/logger";

/** Large sequential chunks — the point is readahead, not throughput fairness. */
const CHUNK_BYTES = 8 * 1024 * 1024;

async function warmFile(path: string): Promise<number> {
  const { size } = await stat(path);
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path, { highWaterMark: CHUNK_BYTES });
    // Data is discarded — reading it is the whole job (populates the cache).
    stream.on("data", () => {});
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  return size;
}

/**
 * Sequentially read each artifact once to populate the host page cache.
 * Files are warmed one at a time (parallel warming would defeat sequential
 * readahead on spinning or contended disks). Never throws.
 */
export async function warmHostPageCache(paths: string[], deps: { logger: Logger }): Promise<void> {
  for (const path of paths) {
    const startedAt = performance.now();
    try {
      const bytes = await warmFile(path);
      deps.logger.info("guest artifact page-cache warm complete", {
        path,
        mib: Math.round(bytes / (1024 * 1024)),
        durationMs: Math.round(performance.now() - startedAt),
      });
    } catch (err) {
      deps.logger.warn("guest artifact page-cache warm failed — continuing", {
        path,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
