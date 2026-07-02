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

Full architecture: `docs/architecture/FIRECRACKER.md`.
