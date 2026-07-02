# Firecracker Orchestrator (`RUN_ADAPTER=firecracker`)

One **microVM per run**. The isolation boundary the platform cares about is a
hardware virtualization boundary (KVM) around the whole run — stronger host
protection than a container: a workload escape compromises a throwaway guest
kernel, not the host.

## Topology — VM-per-run

```
host (Linux + /dev/kvm)                    guest (one Firecracker microVM per run)
──────────────────────────                 ─────────────────────────────────────────
platform API (:PORT)                       /sbin/appstrate-init  (PID 1, overlay + mounts)
├─ lo alias 10.231.255.1/32   ◄── sink ──  └─ guest supervisor    (root, bun)
├─ TAP afc<n> 10.231.x.y/30   ◄── eth0 ──     ├─ sidecar   uid 1000 — full egress
├─ nft table appstrate_fc                     │   └─ integration runners (process adapter)
│  (guest↔host/internet policy)               └─ agent     uid 1001 — lo + sink only
└─ firecracker process (VMM)                      cwd /workspace, MCP → 127.0.0.1:8080
```

Design decision (vs one VM per workload): the sidecar, agent and integration
runners share the guest, separated by uid + in-guest nftables. This keeps the
whole `docs/architecture/SIDECAR.md` contract byte-identical (the sidecar sees
a "process mode" world: loopback URLs, directory workspace,
`INTEGRATION_RUNTIME_ADAPTER=process`) and avoids the unsolvable parts of
VM-per-workload — Firecracker has **no shared filesystem** (no virtiofs/9p),
so a cross-VM `/workspace` and sidecar-spawned runner VMs would each need a
privileged host broker. Trade-off accepted: a guest-kernel exploit exposes
that run's credentials (not the host, not other runs). Docker's equivalent
failure (container escape) exposes the host — strictly worse.

## Per-run resources

| Resource    | Naming                                                                                                 | Created by                |
| ----------- | ------------------------------------------------------------------------------------------------------ | ------------------------- |
| TAP device  | `afc<n>` (n = subnet index)                                                                            | `createIsolationBoundary` |
| /30 subnet  | carved from `FIRECRACKER_SUBNET_CIDR` (/16)                                                            | subnet allocator          |
| run dir     | `FIRECRACKER_DATA_DIR/<runId>/` (state.json, config.img, vmconfig.json, console.log, firecracker.sock) | boundary + start          |
| VMM process | one `firecracker` per run                                                                              | `startWorkload(agent)`    |

The platform is reachable from every guest at the **loopback alias**
`x.y.255.1:PORT` (reserved last /24 of the pool) — `resolvePlatformApiUrl()`
returns it, the host nft `input` chain only accepts that destination from
`afc*`, everything else guest→host is dropped (guests must never reach Redis,
the Docker socket, etc.). Guest→guest is dropped; guest→internet is
masqueraded and reserved, inside the guest, to the sidecar uid.

## Launch sequence

1. `createIsolationBoundary` — allocate /30 + TAP; boundary advertises
   in-guest loopback `sidecarEndpoints` (127.0.0.1:8080/8081).
2. `createSidecar` / `createWorkload` — bookkeeping only: env specs are captured
   (sidecar env mirrors the process orchestrator's, plus
   `INTEGRATION_RUNTIME_ADAPTER=process`).
3. `startWorkload(agent)` — builds the guest config (snake_case
   `config.json`), materialises it as a **read-only ext4 config drive**
   (`mkfs.ext4 -d`, no root needed; secrets never on the kernel cmdline, no
   MMDS size limits), writes the Firecracker `vmconfig.json` (shared rootfs
   attached **read-only**), spawns the VMM. Serial console → `console.log`.
4. Guest boots: kernel `ip=` statics eth0 → init overlays tmpfs on `/`
   (pivot_root) → mounts the config drive → supervisor applies the uid
   firewall → `setpriv` spawns sidecar (1000) then agent (1001).
5. Agent exits → supervisor kills sidecar, prints `APPSTRATE_EXIT:<code>` on
   the console, powers off (`reboot=k` → VMM exit). `waitForExit` returns the
   marker code; a missing marker = crash (1) or kill (137).

Timeout/cancel flow through `stopWorkload`/`stopByRunId` (graceful
`SendCtrlAltDel` attempt, then SIGKILL). Orphans (crash recovery): run-dir
`state.json` pids are killed, `afc*` TAPs deleted, dirs removed at boot.

## Artifacts

Built once, shared by all runs, validated at `initialize()`:

```sh
bun run firecracker:build          # rootfs + kernel
```

- **rootfs** (`FIRECRACKER_ROOTFS_PATH`) — `scripts/firecracker/Dockerfile.rootfs`:
  the `appstrate-pi` image + the compiled sidecar binary + guest init/
  supervisor + nftables/setpriv, exported and converted with `mkfs.ext4 -d`.
  Rebuild whenever the pi/sidecar images change (arch-specific).
- **kernel** (`FIRECRACKER_KERNEL_PATH`) — built by
  `scripts/firecracker/build-kernel.sh` (Docker, no host toolchain): pinned
  6.1 kernel with the Firecracker project's own CI config as base, plus
  `NF_TABLES`/`NF_TABLES_INET`/`NETFILTER_XT_MATCH_OWNER`. The stock
  Firecracker CI kernels canNOT be used as-is — runtime-verified to lack
  nftables AND the iptables owner match entirely (everything `=y`, nothing
  loadable), which would break the in-guest uid firewall.

## Requirements & privileges

- Linux + `/dev/kvm` (+ `firecracker` ≥1.16 and `mkfs.ext4` on PATH).
- `ip`/`nft`/`sysctl` mutations run as root or via passwordless `sudo -n`
  (host-net executor prefixes sudo automatically when non-root).
- Secrets hygiene: the per-run config drive holds the run's credentials on
  disk (0600, deleted with the run) — point `FIRECRACKER_DATA_DIR` at a tmpfs
  to keep them out of persistent storage.

## Env vars

| Var                       | Default                          | Notes                             |
| ------------------------- | -------------------------------- | --------------------------------- |
| `FIRECRACKER_BIN`         | `firecracker`                    | VMM binary                        |
| `FIRECRACKER_KERNEL_PATH` | `./data/firecracker/vmlinux`     | guest kernel                      |
| `FIRECRACKER_ROOTFS_PATH` | `./data/firecracker/rootfs.ext4` | shared read-only rootfs           |
| `FIRECRACKER_DATA_DIR`    | `./data/firecracker/runs`        | per-run state (tmpfs recommended) |
| `FIRECRACKER_SUBNET_CIDR` | `10.231.0.0/16`                  | /16 pool → per-run /30            |

## Development on macOS

Firecracker requires KVM; Apple Silicon (M3+, macOS 15+) provides it through
nested virtualization inside a Lima "vz" VM (verified: microVM boots in
~1.9 s). One entrypoint:

```sh
bun run test:firecracker
```

macOS: creates/starts the `appstrate-fc-dev` Lima VM
(`scripts/firecracker-dev/lima.yaml` — docker, firecracker, bun, e2fsprogs
provisioned), rsyncs the repo to the VM's own disk (the host mount is
read-only — installing Linux node_modules into the host tree would break the
macOS checkout), then runs `vm-smoke.sh`. Linux/CI: runs `vm-smoke.sh`
directly. The suite = artifact build (cached) + firecracker unit tests +
`scripts/firecracker-dev/smoke.ts`, which drives the real orchestrator
lifecycle (TAP → config drive → boot → uid drop → exit marker → teardown)
with a trivial agent argv.

## Known limitations (V1)

- **Boot latency**: VM boot + in-guest bun cold start on every run; no
  snapshot support yet (Firecracker snapshots are the planned optimization).
- **Integration runners** share the sidecar uid inside the guest (process
  adapter semantics) — same trust model as `RUN_ADAPTER=process` for
  runner-vs-sidecar, but hardware-isolated from the host.
- **No jailer yet**: the VMM runs unjailed (chroot/cgroup hardening of the
  firecracker process itself is a planned follow-up).
- Workspace and rootfs overlay are tmpfs-backed → bounded by guest RAM
  (`vmSizing` adds a fixed envelope over the agent budget).
