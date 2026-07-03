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

### Requirements (KVM host)

- Linux host with `/dev/kvm` accessible to the daemon user
- `firecracker` binary >= 1.16 (older releases are exposed to CVE-2026-5747)
- Kernel + rootfs artifacts: `bun run firecracker:build` (see `scripts/` here)

On macOS, develop inside the Lima VM: `bun run test:firecracker` (see `scripts/dev/`).

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

| Variable                         | Default                          | Notes                                                                 |
| -------------------------------- | -------------------------------- | --------------------------------------------------------------------- |
| `FIRECRACKER_BIN`                | `firecracker`                    | VMM binary                                                            |
| `FIRECRACKER_KERNEL_PATH`        | `./data/firecracker/vmlinux`     | Built by `firecracker:build:kernel`                                   |
| `FIRECRACKER_ROOTFS_PATH`        | `./data/firecracker/rootfs.ext4` | Built by `firecracker:build:rootfs`                                   |
| `FIRECRACKER_DATA_DIR`           | `./data/firecracker/runs`        | Per-run state; point at a tmpfs to keep config-drive secrets off disk |
| `FIRECRACKER_SUBNET_CIDR`        | `10.231.0.0/16`                  | /16 pool carved into per-run /30 subnets                              |
| `FIRECRACKER_EGRESS_DENY_CIDRS`  | metadata + RFC1918 ranges        | Destinations guests must never reach                                  |
| `FIRECRACKER_MAX_CONSOLE_BYTES`  | 268435456 (256 MiB)              | Console-size kill switch (host OOM guard)                             |
| `FIRECRACKER_MAX_CONCURRENT_VMS` | 0 (unlimited)                    | Admission control                                                     |

Start: `bun run firecracker:runner` (systemd unit recommended: `Restart=always`, `After=network-online.target`). Boot order: env → `initialize()` (KVM/artifact checks) → orphan sweep → listen. Running VMs are separate processes — a daemon restart re-adopts or reaps them via the orphan sweep, it does not kill them mid-flight.

## Capabilities declared

- `isolatesWorkloads: true` — the microVM boundary lives on the runner host, so run credentials never enter the platform API process; OAuth-subscription runs are allowed on this backend.
- `supportsSidecarOnly: false` — the VM boots exactly once, driven by the agent workload; connect-runs refuse this backend fast.

## Security posture

The wire carries run tokens and credential bundles (`POST /v1/sidecars`) — keep the link trusted: same machine, private network, or TLS via a reverse proxy in front of the daemon. Auth is a single shared token compared in constant time; one platform per daemon (the orphan sweep and `cleanup-orphans` are daemon-wide).

**Protocol**: JSON over HTTP (`runner/protocol.ts`, versioned — client refuses a daemon speaking another major version). Logs stream as NDJSON with reconnect-and-skip; exit codes long-poll.

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
| `runner/logger.ts`                           | Env-free pino logger for the daemon closure (no `@appstrate/env`)     |
| `runner/server.ts`                           | Hono app factory (DI orchestrator — unit-testable)                    |
| `runner/daemon.ts`                           | Entrypoint (`bun run firecracker:runner`)                             |
| `scripts/`                                   | Kernel/rootfs build (`Dockerfile.rootfs`, `build-*.sh`)               |
| `scripts/dev/`                               | Lima dev VM + smoke suite                                             |

Full architecture: `docs/architecture/FIRECRACKER.md`.
