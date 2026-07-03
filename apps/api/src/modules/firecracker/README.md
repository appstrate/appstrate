# Firecracker module

One hardware-isolated [Firecracker](https://firecracker-microvm.github.io/) microVM per agent run. The isolation boundary IS the VM: sidecar, agent, and integration runners all execute inside the same guest, separated by uid + in-guest nftables rules, while the host keeps a KVM boundary around the whole run.

## One topology

The platform is always containerized (Coolify/compose) — it cannot touch `/dev/kvm`, TAP devices, or nftables. So there is a single supported topology: the platform proxies every orchestrator call over HTTP to an `appstrate-runner` daemon running on a KVM-capable host. The daemon embeds the real in-process `FirecrackerOrchestrator` — that class is the daemon's **engine**, not a platform adapter.

```
platform (container)                         KVM host (systemd)
RUN_ADAPTER=firecracker          ── HTTP ──►  appstrate-runner daemon
FIRECRACKER_RUNNER_URL=...                    (drives FirecrackerOrchestrator)
FIRECRACKER_RUNNER_TOKEN=...                  FIRECRACKER_RUNNER_TOKEN=...
                                              FIRECRACKER_RUNNER_PLATFORM_URL=http://<ip>:3000
```

## Activation (platform side)

```sh
MODULES=oidc,webhooks,mcp,core-providers,firecracker   # add "firecracker"
RUN_ADAPTER=firecracker
FIRECRACKER_RUNNER_URL=http://<runner-host>:3100
FIRECRACKER_RUNNER_TOKEN=<shared secret, >=16 chars>
```

The host-side `FIRECRACKER_*` variables (kernel/rootfs paths, subnet CIDR, …) are **not** read platform-side — they configure the daemon. Zero footprint when absent from `MODULES`: no env vars read, no backend registered, no routes, no tables. Boot fails fast with the list of registered backends when `RUN_ADAPTER=firecracker` is set without the module; a stale `RUN_ADAPTER=firecracker-remote` gets a targeted "renamed to `firecracker`" error.

| Variable                   | Notes                                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------- |
| `FIRECRACKER_RUNNER_URL`   | `http(s)` base URL of the daemon. Validated LAZILY (first `initialize()`), not at module load |
| `FIRECRACKER_RUNNER_TOKEN` | Shared bearer secret, ≥16 chars. Sent on every request                                        |

## Daemon side (`appstrate-runner`)

### Install (`appstrate runner install`)

The supported install path is the CLI — no checkout, no bun, no on-host build:

```sh
curl -fsSL https://get.appstrate.dev/runner | sudo bash -s -- \
  --platform-url http://<PLATFORM_IPV4>:3000
# or, CLI already present:  sudo appstrate runner install --platform-url …
```

It preflights the host, downloads + SHA-256-verifies the compiled daemon binary
(`appstrate-runner-<arch>`) and the pinned `firecracker` binary, writes
`/etc/appstrate-runner/env` (0600) + a hardened systemd unit, and
`enable --now`s it. Day-2: `appstrate runner {doctor,update,status,logs}`.
Full flow + `bun build --compile` decoupling notes:
`docs/architecture/FIRECRACKER.md` → "Installing the daemon". The manual
`bun run firecracker:runner` path remains for development.

### Requirements (KVM host)

- Linux host with `/dev/kvm` accessible to the daemon user
- `firecracker` binary >= 1.16 (older releases are exposed to CVE-2026-5747)
- Kernel + rootfs artifacts — **downloaded automatically at boot** (see below);
  no on-host build required for a released daemon

On macOS, develop inside the Lima VM: `bun run test:firecracker` (see `scripts/dev/`).

### Guest artifacts (auto-downloaded)

At boot — **before** `initialize()` — the daemon resolves the guest kernel
(`vmlinux`) and rootfs (`rootfs.ext4`) via `runner/artifacts.ts`:

- If the files are already installed (and, when `FIRECRACKER_ARTIFACTS_VERSION`
  is pinned, the version marker matches), the resolver skips — no download.
- Otherwise it downloads `firecracker-artifacts-manifest.json` +
  `vmlinux-<arch>` + `rootfs-<arch>.ext4.zst` from
  `FIRECRACKER_ARTIFACTS_BASE_URL` (default: this repo's GitHub Releases),
  verifies SHA256 **while streaming**, decompresses the rootfs (Bun's native
  zstd — no external `zstd` binary), and installs both atomically
  (tmp write + rename), writing a version marker.

Failure policy: a **network failure with artifacts already present** is a
warning (boot continues on the existing files). **Missing artifacts + a failed
download** is fatal with an actionable message. A **guest-protocol mismatch**
(the manifest's `guest_protocol` ≠ the daemon's `GUEST_PROTOCOL_VERSION`) or a
**checksum mismatch** is ALWAYS fatal — a daemon never boots artifacts it
cannot drive, nor a corrupt/tampered asset.

Dev iteration on `guest/` (supervisor, init.sh): build locally with
`bun run firecracker:build` and set `FIRECRACKER_ARTIFACTS_LOCAL=1` to skip the
resolver entirely.

Artifacts are published per release by the `firecracker-artifacts` job in
`.github/workflows/release.yml` (matrix `{x86_64, aarch64}`).

### Daemon environment

The daemon owns two schemas — its own listen/link config (`FIRECRACKER_RUNNER_*`, `runner/env.ts`) and the engine's host config (`FIRECRACKER_*`, `runner/host-env.ts`). Neither is part of `@appstrate/env`; the daemon boots on a bare KVM host with **only** these variables (no `BETTER_AUTH_SECRET`/`CONNECTION_ENCRYPTION_KEY`/`UPLOAD_SIGNING_SECRET`).

`FIRECRACKER_RUNNER_*` (`runner/env.ts`):

| Variable                          | Default   | Notes                                                                                                                                                                  |
| --------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FIRECRACKER_RUNNER_TOKEN`        | —         | REQUIRED, ≥16 chars. Shared bearer secret; every request must present it                                                                                               |
| `FIRECRACKER_RUNNER_PORT`         | `3100`    | Daemon listen port                                                                                                                                                     |
| `FIRECRACKER_RUNNER_HOST`         | `0.0.0.0` | Bind narrowly / firewall the port — the launch spec carries run credentials                                                                                            |
| `FIRECRACKER_RUNNER_PLATFORM_URL` | —         | REQUIRED. `http(s)://<IPv4>[:port]` guests use to reach the platform (IP literal — no DNS in guests). The daemon opens an explicit nft accept for exactly this ip:port |

`FIRECRACKER_*` engine config (`runner/host-env.ts`):

| Variable                         | Default                          | Notes                                                                                                       |
| -------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `FIRECRACKER_BIN`                | `firecracker`                    | VMM binary                                                                                                  |
| `FIRECRACKER_KERNEL_PATH`        | `./data/firecracker/vmlinux`     | Auto-downloaded at boot (or built by `firecracker:build:kernel`)                                            |
| `FIRECRACKER_ROOTFS_PATH`        | `./data/firecracker/rootfs.ext4` | Auto-downloaded at boot (or built by `firecracker:build:rootfs`)                                            |
| `FIRECRACKER_DATA_DIR`           | `./data/firecracker/runs`        | Per-run state; point at a tmpfs to keep config-drive secrets off disk                                       |
| `FIRECRACKER_SUBNET_CIDR`        | `10.231.0.0/16`                  | /16 pool carved into per-run /30 subnets                                                                    |
| `FIRECRACKER_EGRESS_DENY_CIDRS`  | metadata + RFC1918 ranges        | Destinations guests must never reach                                                                        |
| `FIRECRACKER_MAX_CONSOLE_BYTES`  | 268435456 (256 MiB)              | Console-size kill switch (host OOM guard)                                                                   |
| `FIRECRACKER_MAX_CONCURRENT_VMS` | 16 (`0` = unlimited)             | Admission control — race-free slot reservation; size by host RAM ÷ per-guest memory. `0` opts out entirely  |
| `FIRECRACKER_ARTIFACTS_BASE_URL` | this repo's GH Releases          | Guest-artifact download base — point at a mirror for air-gapped hosts                                       |
| `FIRECRACKER_ARTIFACTS_VERSION`  | latest / on-disk                 | Pin a release (`1.2.3`); unset = skip download when artifacts present                                       |
| `FIRECRACKER_ARTIFACTS_LOCAL`    | unset                            | `=1` skips the resolver — dev iterating on locally built artifacts                                          |
| `FIRECRACKER_NET_VERIFY`         | `warn`                           | Boot-time guest→platform path probe: `warn` logs a dropped path, `strict` refuses to start on a proven drop |

Start: `bun run firecracker:runner` (systemd unit recommended: `Restart=always`, `After=network-online.target`). Boot order: env → **artifacts** (download/verify kernel + rootfs) → `initialize()` (KVM/artifact checks) → orphan sweep → **guest-path self-verification** (net probe) → listen. Running VMs are separate processes — a daemon restart re-adopts or reaps them via the orphan sweep, it does not kill them mid-flight.

## Capabilities declared

- `isolatesWorkloads: true` — the microVM boundary lives on the runner host, so run credentials never enter the platform API process; OAuth-subscription runs are allowed on this backend.
- `supportsSidecarOnly: false` — the VM boots exactly once, driven by the agent workload; connect-runs refuse this backend fast.

## Security posture

The wire carries run tokens and credential bundles (`POST /v1/sidecars`) — keep the link trusted: same machine, private network, or TLS via a reverse proxy in front of the daemon. Auth is a single shared token compared in constant time; one platform per daemon (the orphan sweep and `cleanup-orphans` are daemon-wide).

**Protocol**: JSON over HTTP (`runner/protocol.ts`, versioned — client refuses a daemon speaking another major version). Logs stream as NDJSON with reconnect-and-skip; exit codes long-poll.

## Debugging a failed run

The daemon deletes the per-run workspace (with `console.log`) at teardown, so observability is built into the teardown path rather than the disk:

- **Structured teardown log** — every microVM destruction emits `Firecracker workload destroyed` with `{ runId, reason, exitMarkerFound, uptimeMs }`. `reason` is one of `finalize` (run ended normally), `watchdog-kill` (platform stopped the run by id — stall watchdog or user cancel), `orphan-sweep` (boot-time reclamation of a crashed predecessor), `shutdown` (daemon stopping), or `crash` (VMM exited abnormally without an intentional stop). There is no longer a silent gap between "microVM booted" and cleanup.
- **Console retention** — the last 256 KiB of the console is copied to `<FIRECRACKER_DATA_DIR>/../console-archive/<runId>.log` **before** the workspace is deleted (the archive dir is pruned to the 100 most recent files). Archiving never fails a teardown — a failure only warns. Orphan-swept runs are archived too, so a crash that predated the daemon restart stays debuggable.
- **Console API** — `GET /v1/workloads/:id/console?tailBytes=N` (bearer-authed, `N` ≤ 256 KiB, default 64 KiB) serves the live console while the VM runs, else the archive; `404` when neither exists. `:id` is the run id.
- **Abnormal-exit surfacing** — when a run exits non-zero (crash / kill / watchdog), the platform fetches a ~2 KiB console tail and attaches it to the run as a `system` / `firecracker_console` run-log row (visible in the UI). Best-effort: it never blocks or fails the run's finalize.
- **Boot-phase liveness** — a slow-booting guest has not yet emitted its first sink event, so the platform stall watchdog would kill it. While the daemon confirms the VMM is alive (`POST /v1/workloads/status`) and the guest is still silent, the platform records a synthetic heartbeat (`runs.last_heartbeat_at`, the exact column the watchdog reads) every 15 s, stopping the moment real events flow or the VM exits. It never masks a dead VM — a `running: false` status stops the synthetic beat immediately.
- **Boot-time guest-path self-verification** — before the port opens, the daemon probes whether a guest could actually reach the platform through the freshly-applied nft policy (`runner/net-probe.ts`), turning the DNAT drop that once cost hours of `tcpdump` into a one-line boot diagnostic. The result is reported verbatim on `GET /v1/health` (`platformReachable`, `guestPathVerified`). `FIRECRACKER_NET_VERIFY=warn` (default) only logs a proven drop; `strict` refuses to start on one. An unverifiable path (probe couldn't decide) is always non-fatal.

## Layout

| Path                                         | Contents                                                              |
| -------------------------------------------- | --------------------------------------------------------------------- |
| `index.ts`                                   | Module manifest + single `firecracker` `orchestrators()` contribution |
| `remote-env.ts`                              | Platform-side client env (`FIRECRACKER_RUNNER_*`, lazy)               |
| `remote-orchestrator.ts`                     | `RemoteFirecrackerOrchestrator` — the `RunOrchestrator` HTTP client   |
| `orchestrator.ts`                            | `FirecrackerOrchestrator` — the daemon's in-process engine            |
| `host-net.ts` / `subnet.ts` / `vm-config.ts` | Host TAP/nftables, /30 allocator, VM + guest config                   |
| `guest/`                                     | In-guest supervisor, init, runner-exec wrapper, wire types            |
| `runner/protocol.ts`                         | Frozen wire schemas + route map (shared both sides)                   |
| `runner/env.ts`                              | Daemon-side `FIRECRACKER_RUNNER_*` schema                             |
| `runner/host-env.ts`                         | Engine-side `FIRECRACKER_*` schema (daemon-only)                      |
| `runner/artifacts.ts`                        | Boot-time guest-artifact resolver (download + verify + install)       |
| `runner/logger.ts`                           | Env-free pino logger for the daemon closure (no `@appstrate/env`)     |
| `runner/server.ts`                           | Hono app factory (DI orchestrator — unit-testable)                    |
| `runner/daemon.ts`                           | Entrypoint (`bun run firecracker:runner`)                             |
| `scripts/`                                   | Kernel/rootfs build (`Dockerfile.rootfs`, `build-*.sh`)               |
| `scripts/dev/`                               | Lima dev VM + smoke suite                                             |

Full architecture: `docs/architecture/FIRECRACKER.md`.
