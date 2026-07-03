# Firecracker module

One hardware-isolated [Firecracker](https://firecracker-microvm.github.io/) microVM per agent run. The isolation boundary IS the VM: sidecar, agent, and integration runners all execute inside the same guest, separated by uid + in-guest nftables rules, while the host keeps a KVM boundary around the whole run.

## Activation

```sh
MODULES=oidc,webhooks,mcp,core-providers,firecracker   # add "firecracker"
RUN_ADAPTER=firecracker
```

Zero footprint when absent from `MODULES`: no env vars read, no backend registered, no routes, no tables. Boot fails fast with the list of registered backends when `RUN_ADAPTER=firecracker` is set without the module.

## Requirements

- Linux host with `/dev/kvm` accessible to the API user
- `firecracker` binary >= 1.16 (older releases are exposed to CVE-2026-5747)
- Kernel + rootfs artifacts: `bun run firecracker:build` (see `scripts/` here)

On macOS, develop inside the Lima VM: `bun run test:firecracker` (see `scripts/dev/`).

## Environment variables

Owned by this module (validated at module `init()`, NOT part of `@appstrate/env`):

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

## Layout

| Path                                         | Contents                                                   |
| -------------------------------------------- | ---------------------------------------------------------- |
| `index.ts`                                   | Module manifest + `orchestrators()` contribution           |
| `env.ts`                                     | `FIRECRACKER_*` Zod schema                                 |
| `orchestrator.ts`                            | `FirecrackerOrchestrator` (RunOrchestrator implementation) |
| `host-net.ts` / `subnet.ts` / `vm-config.ts` | Host TAP/nftables, /30 allocator, VM + guest config        |
| `guest/`                                     | In-guest supervisor, init, runner-exec wrapper, wire types |
| `scripts/`                                   | Kernel/rootfs build (`Dockerfile.rootfs`, `build-*.sh`)    |
| `scripts/dev/`                               | Lima dev VM + smoke suite                                  |

## Capabilities declared

- `isolatesWorkloads: true` — run credentials never enter the host API process; OAuth-subscription runs are allowed on this backend.
- `supportsSidecarOnly: false` — the VM boots exactly once, driven by the agent workload; connect-runs refuse this backend fast.

Both backends below declare the same pair (`firecracker-remote` isolates too: the microVM lives on the runner host, so credentials still never enter the platform API process).

## Remote run-plane — `appstrate-runner` (issue #819, phase 1)

When the platform API runs inside a container (Coolify/compose), it cannot own KVM. The module also ships a small host daemon and a second backend that drives it over HTTP:

```
platform (container)                         KVM host (systemd)
RUN_ADAPTER=firecracker-remote  ── HTTP ──►  bun run firecracker:runner
FIRECRACKER_RUNNER_URL=...                   (wraps FirecrackerOrchestrator)
FIRECRACKER_RUNNER_TOKEN=...                 FIRECRACKER_RUNNER_TOKEN=...
                                             FIRECRACKER_RUNNER_PLATFORM_URL=http://<ip>:3000
```

**Daemon side** (the KVM host — same requirements as above, plus a repo checkout):

| Variable                          | Default   | Notes                                                                                                                                                                  |
| --------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FIRECRACKER_RUNNER_TOKEN`        | —         | REQUIRED, ≥16 chars. Shared bearer secret; every request must present it                                                                                               |
| `FIRECRACKER_RUNNER_PORT`         | `3100`    | Daemon listen port                                                                                                                                                     |
| `FIRECRACKER_RUNNER_HOST`         | `0.0.0.0` | Bind narrowly / firewall the port — the launch spec carries run credentials                                                                                            |
| `FIRECRACKER_RUNNER_PLATFORM_URL` | —         | REQUIRED. `http(s)://<IPv4>[:port]` guests use to reach the platform (IP literal — no DNS in guests). The daemon opens an explicit nft accept for exactly this ip:port |

Start: `bun run firecracker:runner` (systemd unit recommended: `Restart=always`, `After=network-online.target`). The daemon initializes the orchestrator (KVM/artifact checks), sweeps orphans from a previous crash, then serves. Running VMs are separate processes — a daemon restart re-adopts or reaps them via the orphan sweep, it does not kill them mid-flight.

**Platform side**: add `firecracker` to `MODULES`, set `RUN_ADAPTER=firecracker-remote`, `FIRECRACKER_RUNNER_URL=http://<runner-host>:3100`, `FIRECRACKER_RUNNER_TOKEN=<same secret>`. The host-side `FIRECRACKER_*` variables are NOT needed platform-side (module `init()` still parses them — defaults are harmless, no KVM check happens at init).

**Security posture**: the wire carries run tokens and credential bundles (`POST /v1/sidecars`) — keep the link trusted: same machine, private network, or TLS via a reverse proxy in front of the daemon. Auth is a single shared token compared in constant time; one platform per daemon (the orphan sweep and `cleanup-orphans` are daemon-wide).

**Protocol**: JSON over HTTP (`runner/protocol.ts`, versioned — client refuses a daemon speaking another major version). Logs stream as NDJSON with reconnect-and-skip; exit codes long-poll.

## Layout (runner)

| Path                     | Contents                                                 |
| ------------------------ | -------------------------------------------------------- |
| `runner/protocol.ts`     | Frozen wire schemas + route map (shared both sides)      |
| `runner/env.ts`          | Daemon-side `FIRECRACKER_RUNNER_*` schema                |
| `runner/server.ts`       | Hono app factory (DI orchestrator — unit-testable)       |
| `runner/daemon.ts`       | Entrypoint (`bun run firecracker:runner`)                |
| `remote-env.ts`          | Platform-side client env (lazy — validated at first use) |
| `remote-orchestrator.ts` | `RunOrchestrator` HTTP client                            |

Full architecture: `docs/architecture/FIRECRACKER.md`.
