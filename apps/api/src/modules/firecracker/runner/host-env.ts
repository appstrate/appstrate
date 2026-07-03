// SPDX-License-Identifier: Apache-2.0

/**
 * Firecracker HOST environment (the microVM engine's config surface) —
 * validated here, NOT in @appstrate/env. These variables are DAEMON-ONLY:
 * the containerized platform never runs VMs and never reads them; they
 * configure the `appstrate-runner` daemon (and the dev smoke harness),
 * which drive {@link FirecrackerOrchestrator} on the KVM host. Kept next
 * to runner/env.ts (the daemon's FIRECRACKER_RUNNER_* surface) — the two
 * schemas validate distinct surfaces and stay separate. Parsed once at
 * daemon boot (fail-fast with Zod messages) and cached for the process
 * lifetime.
 */

import { z } from "zod";

const firecrackerEnvSchema = z.object({
  // Linux + /dev/kvm only. Artifacts are resolved at daemon boot by
  // runner/artifacts.ts (download + SHA256 verify + zstd decompress from
  // GitHub Release assets) OR built locally by `bun run firecracker:build`
  // (see apps/api/src/modules/firecracker/scripts/) — the orchestrator
  // fails fast at initialize() when the kernel/rootfs are still missing.
  FIRECRACKER_BIN: z.string().default("firecracker"),
  FIRECRACKER_KERNEL_PATH: z.string().default("./data/firecracker/vmlinux"),
  FIRECRACKER_ROOTFS_PATH: z.string().default("./data/firecracker/rootfs.ext4"),
  FIRECRACKER_DATA_DIR: z.string().default("./data/firecracker/runs"),
  // Prebuilt guest-artifact resolution (issue #819, phase 2). At boot the
  // daemon downloads versioned, checksum-verified vmlinux + rootfs from
  // GitHub Release assets instead of requiring an on-host docker build.
  //
  // Base URL of the release assets. Optional — defaults to this repo's GH
  // Releases (see DEFAULT_ARTIFACTS_BASE_URL in runner/artifacts.ts). Point
  // it at a mirror for air-gapped or self-hosted deployments.
  FIRECRACKER_ARTIFACTS_BASE_URL: z.url().optional(),
  // Pin a specific release (e.g. "1.2.3" or "v1.2.3"). Optional — when the
  // artifacts already exist on disk and no version is pinned, the resolver
  // skips the download; when they are missing and no version is pinned it
  // fetches the `latest` release.
  FIRECRACKER_ARTIFACTS_VERSION: z.string().optional(),
  // Dev opt-out: `=1` (or `true`) skips the resolver entirely — the
  // developer builds artifacts locally with `bun run firecracker:build`
  // and iterates on guest/ without any download.
  FIRECRACKER_ARTIFACTS_LOCAL: z
    .string()
    .optional()
    .transform((v) => v === "1" || v?.toLowerCase() === "true"),
  // IPv4 /16 pool carved into per-run /30 subnets (host TAP peer + guest).
  // Override when the default collides with an existing route.
  FIRECRACKER_SUBNET_CIDR: z
    .string()
    .regex(/^\d+\.\d+\.0\.0\/16$/, "must be a /16 CIDR ending in .0.0/16")
    .default("10.231.0.0/16"),
  // Destinations guests must never reach through the host's forward path,
  // even when a workload has egress: cloud metadata endpoints (instance
  // credentials) and RFC1918 ranges (Docker bridges, LAN, VPC neighbours).
  // Comma-separated CIDRs. Narrow this list only for deployments that
  // intentionally expose private-range services to guest workloads.
  FIRECRACKER_EGRESS_DENY_CIDRS: z
    .string()
    .regex(
      /^\d+\.\d+\.\d+\.\d+\/\d+(,\d+\.\d+\.\d+\.\d+\/\d+)*$/,
      "must be comma-separated IPv4 CIDRs",
    )
    .default("169.254.0.0/16,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"),
  // Per-run serial console log cap (bytes). The console aggregates the
  // guest kernel + supervisor + full workload stdout and appends
  // unbounded — with FIRECRACKER_DATA_DIR on a tmpfs a chatty workload
  // becomes a host OOM vector. A VM whose console exceeds the cap is
  // killed (the run fails). Default 256 MiB.
  FIRECRACKER_MAX_CONSOLE_BYTES: z.coerce.number().int().positive().default(268_435_456),
  // Admission control: maximum concurrent microVMs on this host.
  // 0 (default) = unlimited. When the cap is reached, new runs fail
  // fast instead of overcommitting host RAM.
  FIRECRACKER_MAX_CONCURRENT_VMS: z.coerce.number().int().nonnegative().default(0),
  // Guest→platform network self-verification at daemon boot (see
  // runner/net-probe.ts). `warn` (default) logs a loud diagnostic and
  // keeps booting when the guest path is proven broken; `strict` makes
  // that failure fatal (the daemon refuses to serve a host where runs
  // could not reach the platform). A path that merely could NOT be
  // verified (netns/curl tooling absent, or the platform itself down) is
  // never fatal in either mode — an unproven path is not a proven
  // failure.
  FIRECRACKER_NET_VERIFY: z.enum(["warn", "strict"]).default("warn"),
});

export type FirecrackerEnv = z.infer<typeof firecrackerEnvSchema>;

let cached: FirecrackerEnv | undefined;

/** Parse (once) and return the module's environment. Throws on invalid values. */
export function getFirecrackerEnv(): FirecrackerEnv {
  if (!cached) {
    cached = firecrackerEnvSchema.parse(process.env);
  }
  return cached;
}

/** Test seam — drop the cache so the next read re-parses process.env. */
export function _resetFirecrackerEnvCacheForTesting(): void {
  cached = undefined;
}
