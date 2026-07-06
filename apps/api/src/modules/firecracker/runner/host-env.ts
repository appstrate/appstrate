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
  // Per-VM confinement via the upstream `jailer` (chroot + per-VM uid +
  // cgroup bounds). Default ON — production posture. "off" is the dev
  // escape hatch (unprivileged host, no root): the VMM then runs
  // unjailed under the daemon's own uid, loudly warned at initialize().
  // "on" requires the daemon to run as root (the systemd unit does).
  FIRECRACKER_JAILER: z.enum(["on", "off"]).default("on"),
  // The jailer binary — ships in the SAME upstream release tarball as
  // `firecracker` and must come from the same release. The installer
  // places it at <dataDir>/bin/jailer (on the unit's PATH).
  FIRECRACKER_JAILER_BIN: z.string().default("jailer"),
  // Base of the per-VM uid/gid range: VM with subnet index N runs as
  // uid/gid BASE+N. The range BASE..BASE+FIRECRACKER_MAX_CONCURRENT_VMS
  // (worst case BASE+16319, the allocator ceiling) must be unallocated
  // on the host — no /etc/passwd entries are needed or created. The
  // default sits ABOVE the 16-bit uid space so the range can never
  // collide with nobody (65534/65535) or the systemd DynamicUser pool
  // (61184–65519) — a VMM silently running as `nobody` would cross an
  // unrelated trust domain. Ranges intersecting 61184–65535 are rejected
  // at boot (see the superRefine below).
  FIRECRACKER_JAIL_UID_BASE: z.coerce.number().int().min(1000).default(200_000),
  // Ceiling on the per-run MMDS credential payload (serialized bytes).
  // Above Firecracker's 50 KiB store default the daemon raises the VMM's
  // --mmds-size-limit/--http-api-max-payload-size to fit the payload;
  // above THIS ceiling the run FAILS instead — a known secret is never
  // silently written to the config drive (fail-closed). Default 16 MiB:
  // INTEGRATIONS_TO_SPAWN_JSON carries bundle bytes + live tokens and
  // can legitimately reach several MiB; the store lives in VMM memory,
  // covered by the jail's memory slack.
  FIRECRACKER_MMDS_MAX_BYTES: z.coerce.number().int().positive().default(16_777_216),
  // cgroup-v2 bounds (memory.max / pids.max under the appstrate-fc
  // slice) passed to the jailer. The jailer fails HARD when it cannot
  // write the cgroup files — "off" lets hosts without cgroup-v2
  // delegation keep the jail while dropping the resource bounds.
  FIRECRACKER_JAIL_CGROUPS: z.enum(["on", "off"]).default("on"),
  // How the run's raw credentials reach the guest. "mmds" (default,
  // production posture) keeps the secret keys OUT of the config drive:
  // they stay in daemon memory and are served, per-run, through
  // Firecracker's in-memory MMDS data store (PUT /mmds over the VMM API
  // socket) — the guest supervisor (root) fetches them at boot over the
  // link-local 169.254.169.254 interface and injects them in-process,
  // then the guest firewall clamps MMDS shut for every uid. "config-drive"
  // is the pre-MMDS behavior (all credentials materialised onto the
  // read-only ext4 config drive) — an escape hatch for bisecting a boot
  // regression or developing without the broker.
  FIRECRACKER_CREDENTIAL_BROKER: z.enum(["mmds", "config-drive"]).default("mmds"),
  // Prebuilt guest-artifact resolution (issue #819, phase 2). At boot the
  // daemon downloads versioned, checksum-verified vmlinux + rootfs from this
  // repo's GitHub Release assets (see DEFAULT_ARTIFACTS_BASE_URL in
  // runner/artifacts.ts) instead of requiring an on-host docker build.
  //
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
  // Admission control: maximum concurrent microVMs on this host. When the
  // cap is reached, new runs fail fast instead of overcommitting host RAM.
  // Default 16 — a conservative fixed ceiling (E2B/Fly/Firecracker sizing
  // guidance is host RAM ÷ per-guest memory; at the default ~1 GiB guest
  // that fits a 16-32 GiB host beside the platform + daemon). Raise it on
  // larger hosts. 0 = explicit, opt-in unlimited (no admission control).
  FIRECRACKER_MAX_CONCURRENT_VMS: z.coerce.number().int().nonnegative().default(16),
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

/**
 * Reserved uid interval no jail uid may fall into: systemd DynamicUser
 * (61184–65519) plus nobody/overflow (65534/65535). A VMM allocated one
 * of these uids would share an identity with unrelated system services —
 * file ownership, TAP ownership and the orphan sweep all key on the uid.
 */
const RESERVED_UID_RANGE = { lo: 61_184, hi: 65_535 } as const;

/** Allocator index ceiling (see subnet.ts MAX_INDEX) — the worst-case uid span. */
const MAX_JAIL_UID_SPAN = 16_319;

const firecrackerEnvSchemaChecked = firecrackerEnvSchema.superRefine((env, ctx) => {
  // The uid range actually reachable: with admission control on, the
  // lowest-free allocator keeps indexes <= the VM cap; without a cap
  // (explicit 0) the full allocator ceiling applies.
  const span =
    env.FIRECRACKER_MAX_CONCURRENT_VMS > 0 ? env.FIRECRACKER_MAX_CONCURRENT_VMS : MAX_JAIL_UID_SPAN;
  const lo = env.FIRECRACKER_JAIL_UID_BASE;
  const hi = env.FIRECRACKER_JAIL_UID_BASE + span;
  if (lo <= RESERVED_UID_RANGE.hi && hi >= RESERVED_UID_RANGE.lo) {
    ctx.addIssue({
      code: "custom",
      path: ["FIRECRACKER_JAIL_UID_BASE"],
      message:
        `jail uid range ${lo}..${hi} intersects the reserved interval ` +
        `${RESERVED_UID_RANGE.lo}..${RESERVED_UID_RANGE.hi} (systemd DynamicUser + nobody) — ` +
        `pick a base whose whole range clears it (e.g. the default 200000)`,
    });
  }
});

export type FirecrackerEnv = z.infer<typeof firecrackerEnvSchema>;

/**
 * The per-VM jail uid interval actually reachable on this host:
 * `FIRECRACKER_JAIL_UID_BASE` .. base + span, where span is the VM cap
 * (admission control keeps the lowest-free allocator below it) or the
 * full allocator ceiling when the cap is the explicit opt-in 0. Single
 * source shared by the boot-time reserved-range check (superRefine
 * above) and the host firewall's VMM output guard (host-net.ts) — the
 * two must never disagree on what "a VMM uid" is.
 */
export function jailUidRange(env: FirecrackerEnv): { base: number; hi: number } {
  const span =
    env.FIRECRACKER_MAX_CONCURRENT_VMS > 0 ? env.FIRECRACKER_MAX_CONCURRENT_VMS : MAX_JAIL_UID_SPAN;
  return { base: env.FIRECRACKER_JAIL_UID_BASE, hi: env.FIRECRACKER_JAIL_UID_BASE + span };
}

let cached: FirecrackerEnv | undefined;

/** Parse (once) and return the module's environment. Throws on invalid values. */
export function getFirecrackerEnv(): FirecrackerEnv {
  if (!cached) {
    cached = firecrackerEnvSchemaChecked.parse(process.env);
  }
  return cached;
}

/** Test seam — drop the cache so the next read re-parses process.env. */
export function _resetFirecrackerEnvCacheForTesting(): void {
  cached = undefined;
}
