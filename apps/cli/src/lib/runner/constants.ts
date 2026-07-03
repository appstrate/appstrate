// SPDX-License-Identifier: Apache-2.0

/**
 * Fixed paths, version pins, and arch mapping for the `appstrate runner`
 * command group.
 *
 * The daemon (`appstrate-runner`) and its guest artifacts run on a bare
 * KVM host, so everything the CLI installs lives under a small, fixed set
 * of well-known locations:
 *
 *   - the daemon binary at {@link RUNNER_BIN_PATH} (system PATH),
 *   - its config at {@link RUNNER_ENV_PATH} (0600, root-only — carries the
 *     bearer token that guards the credential-bearing /v1 surface),
 *   - a hardened systemd unit at {@link RUNNER_UNIT_PATH},
 *   - all mutable state (kernel, rootfs, per-run dirs, the firecracker
 *     binary) rooted at {@link RUNNER_DATA_DIR} so a single systemd
 *     `ReadWritePaths=` covers it.
 *
 * The data-dir rooting is what makes the daemon binary survive
 * `bun build --compile`: the engine reads its kernel/rootfs/run paths from
 * FIRECRACKER_* env vars (host-env.ts), which the install command pins to
 * absolute paths here instead of the cwd-relative `./data/firecracker/*`
 * defaults. Under systemd the working directory is `/`, so a relative
 * default would resolve to `/data/firecracker` — the explicit env pins
 * remove that ambiguity.
 */

/** systemd service name (unit file basename without `.service`). */
export const RUNNER_SERVICE_NAME = "appstrate-runner";

/** Installed daemon binary — on PATH so the unit's ExecStart is a bare path. */
export const RUNNER_BIN_PATH = "/usr/local/bin/appstrate-runner";

/** Hardened systemd unit written by `runner install`. */
export const RUNNER_UNIT_PATH = "/etc/systemd/system/appstrate-runner.service";

/** Config directory + EnvironmentFile (0600 — carries the bearer token). */
export const RUNNER_ETC_DIR = "/etc/appstrate-runner";
export const RUNNER_ENV_PATH = "/etc/appstrate-runner/env";

/**
 * Default state root. Kernel, rootfs, per-run dirs and the pinned
 * firecracker binary all live under here so one `ReadWritePaths=` in the
 * unit grants the daemon exactly the writable surface it needs and nothing
 * else. Overridable via `runner install --data-dir`.
 */
export const RUNNER_DATA_DIR = "/var/lib/appstrate-runner";

/** Default daemon listen port (matches FIRECRACKER_RUNNER_PORT's own default). */
export const RUNNER_DEFAULT_PORT = 3100;

/**
 * Firecracker VMM version the daemon is validated against. The engine
 * enforces `>= 1.16` at initialize() (older releases are exposed to
 * CVE-2026-5747); pin the exact release the repo's build scripts already
 * target (`scripts/build-kernel.sh`, `scripts/dev/lima.yaml`).
 */
export const FIRECRACKER_VERSION = "1.16.0";

/** GitHub Release base for the pinned upstream firecracker binary. */
export const FIRECRACKER_RELEASE_BASE =
  "https://github.com/firecracker-microvm/firecracker/releases/download";

/** GitHub Release base for the appstrate daemon binary + its sha256 sidecar. */
export const APPSTRATE_RELEASE_BASE = "https://github.com/appstrate/appstrate/releases";

/** Guest/daemon architectures — mirror the CI publication matrix + firecracker's own labels. */
export type RunnerArch = "x86_64" | "aarch64";

/**
 * Map Node/Bun `process.arch` to the release arch label used by BOTH the
 * appstrate daemon assets and the upstream firecracker assets (they happen
 * to agree on `x86_64` / `aarch64`). Throws on anything we do not publish.
 */
export function resolveRunnerArch(nodeArch: string = process.arch): RunnerArch {
  switch (nodeArch) {
    case "x64":
      return "x86_64";
    case "arm64":
      return "aarch64";
    default:
      throw new Error(
        `unsupported architecture "${nodeArch}" — the appstrate runner daemon is ` +
          `published for x86_64 (x64) and aarch64 (arm64) only`,
      );
  }
}

/** Daemon release asset name for a given arch, e.g. `appstrate-runner-x86_64`. */
export function daemonAssetName(arch: RunnerArch): string {
  return `appstrate-runner-${arch}`;
}

/**
 * Resolve the concrete paths the daemon's FIRECRACKER_* env vars point at,
 * anchored under a data dir. Kept in one place so the env-file renderer,
 * the artifact-marker reader (doctor), and tests all agree.
 */
export function runnerDataPaths(dataDir: string): {
  kernelPath: string;
  rootfsPath: string;
  runsDir: string;
  firecrackerBin: string;
  binDir: string;
  artifactsMarker: string;
} {
  return {
    kernelPath: `${dataDir}/vmlinux`,
    rootfsPath: `${dataDir}/rootfs.ext4`,
    runsDir: `${dataDir}/runs`,
    binDir: `${dataDir}/bin`,
    firecrackerBin: `${dataDir}/bin/firecracker`,
    // Written by runner/artifacts.ts next to the rootfs (VERSION_MARKER_NAME).
    artifactsMarker: `${dataDir}/.firecracker-artifacts.json`,
  };
}
