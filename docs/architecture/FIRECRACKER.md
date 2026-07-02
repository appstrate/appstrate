# Firecracker Orchestrator (`RUN_ADAPTER=firecracker`)

One **microVM per run**. The isolation boundary the platform cares about is a
hardware virtualization boundary (KVM) around the whole run — stronger host
protection than a container: a workload escape compromises a throwaway guest
kernel, not the host.

## Production status — EXPERIMENTAL

Treat this backend as **experimental**. Two hardening gaps must close before
it is production-grade:

1. **No jailer.** Firecracker's own production guidance requires running the
   VMM under the upstream `jailer` (or equivalent confinement: chroot,
   cgroups, seccomp, dedicated uid). Today the VMM runs unjailed **on the
   same uid that holds passwordless `sudo ip/nft/sysctl/iptables`** (the
   host-net executor) — so a VMM escape lands on a uid that can rewrite the host
   firewall and network, a compounding blast-radius issue. Until jailer
   adoption, treat that sudoers entry as part of the platform's TCB.
2. **In-guest credentials.** The run's raw credentials (the sidecar env:
   LLM keys, OAuth tokens, RUN_TOKEN) live inside the guest, separated from
   the untrusted agent only by uid + `/proc` hidepid. A guest-kernel LPE
   reads them. The blast radius is that one run's credentials — the per-run
   VM still protects the host and every other run — but a kernel LPE is a
   realistic attacker step, not a theoretical one.

To be explicit about what defends what: **the security boundary is the
per-run VM (KVM)**. The in-guest uid + nftables separation is
defense-in-depth against a non-kernel-capable agent, never the credential
boundary itself.

Planned mitigations: jailer + per-VM cgroup slices; a vsock credential
broker (credentials stay host-side and are injected on request instead of
riding the config drive); a seccomp profile for the agent process.

## Topology — VM-per-run

```
host (Linux + /dev/kvm)                    guest (one Firecracker microVM per run)
──────────────────────────                 ─────────────────────────────────────────
platform API (:PORT)                       /sbin/appstrate-init  (PID 1, overlay + mounts,
├─ lo alias 10.231.255.1/32   ◄── sink ──  │                      /proc hidepid=2)
├─ TAP afc<n> 10.231.x.y/30   ◄── eth0 ──  └─ guest supervisor    (root, bun)
├─ nft table appstrate_fc                     ├─ sidecar   uid 1000 — full egress
│  (guest↔host/internet policy)               │   └─ integration runners uid 1002
└─ firecracker process (VMM)                  │       (setuid wrapper, own uid, egress)
                                              └─ agent     uid 1001 — lo + sink only
                                                  cwd /workspace, MCP → 127.0.0.1:8080
```

Design decision (vs one VM per workload): the sidecar, agent and integration
runners share the guest, separated by uid + in-guest nftables — a
defense-in-depth layer against a non-kernel-capable agent, not the security
boundary (that is the VM; see _Production status_). This keeps the
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
the Docker socket, etc.). Guest→guest is dropped; guest egress to cloud
metadata (169.254.0.0/16) and RFC1918 ranges is dropped in the host `forward`
chain (`FIRECRACKER_EGRESS_DENY_CIDRS`) — "egress" means the internet, never
the host's private neighbourhood. Everything else guest→internet is
masqueraded and reserved, inside the guest, to the sidecar/runner uids
(default-deny `output` chain; IPv6 is disabled in the guest entirely).

Fail-closed: `initialize()` sets up the host firewall; if it failed at boot,
`createIsolationBoundary` refuses to start runs rather than running without
host↔guest isolation.

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
   (pivot_root, `/proc` mounted `hidepid=2`) → mounts the config drive →
   supervisor applies the default-deny uid firewall → **unmounts the config
   drive** (no workload can ever read the launch spec) → `setpriv` spawns
   sidecar (1000; not hardened — it execs the setuid runner wrapper) then
   agent (1001, `--no-new-privs --bounding-set -all`). Integration runners
   exec through `appstrate-runner-exec` (setuid root, group-1000-only) and
   land on uid 1002.
5. Agent exits → supervisor kills sidecar, prints
   `APPSTRATE_EXIT:<nonce>:<code>` on the console, powers off (`reboot=k` →
   VMM exit). The nonce is a per-run random value from the config drive —
   the console is shared with workload stdout, so an un-nonced marker is a
   potential forgery and is ignored. `waitForExit` returns the authenticated
   marker code; a missing/forged marker = crash (1) or kill (137).

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

- Linux + `/dev/kvm` (+ `firecracker` ≥1.16 — enforced at `initialize()`,
  older releases are exposed to CVE-2026-5747 —, `mkfs.ext4` and `debugfs`
  — both from e2fsprogs — on PATH).
- `ip`/`nft`/`sysctl`/`iptables` mutations run as root or via passwordless
  `sudo -n` (host-net executor prefixes sudo automatically when non-root).
  `iptables` matters on any host running dockerd: Docker sets the FORWARD
  policy to DROP, and without the iptables accepts the guests' egress is
  silently blocked (the insert failure is logged as a warning at boot).
- **Host hygiene** (from Firecracker's production host setup guide): on
  multi-tenant hosts disable SMT (`nosmt`) and KSM, disable swap entirely
  (guest memory must never hit persistent storage), and keep the host
  kernel + CPU microcode patched per your distro's advisories.
- Secrets hygiene: the per-run config drive holds the run's credentials on
  disk (0600, in-image ownership forced to root:root 0400 via `debugfs`,
  deleted with the run) — point `FIRECRACKER_DATA_DIR` at a tmpfs to keep
  them out of persistent storage. In-guest, the drive is unmounted before
  any workload starts.

## Operational constraints

- **One orchestrator process per host.** `initialize()` takes an advisory
  pidfile lock at `FIRECRACKER_DATA_DIR/orchestrator.pid` (stale-pid
  takeover); a second instance refuses to boot. Two instances would sweep
  each other's live `afc*` TAP devices and collide on subnet indexes.
- **Admission cap.** `FIRECRACKER_MAX_CONCURRENT_VMS` (`0` = unlimited): at
  the cap, `createIsolationBoundary` fails the run fast instead of
  overcommitting host RAM with another VM.
- **Console ceiling.** The serial console (guest kernel + supervisor + full
  workload stdout) appends unbounded; a per-VM watchdog kills the VM — the
  run fails — once `console.log` exceeds `FIRECRACKER_MAX_CONSOLE_BYTES`.
- **Capacity planning.** Per-run guest RAM =
  `agent MiB + 512 MiB` (256 MiB sidecar — dropped for skipSidecar runs —
  plus 256 MiB kernel/init/overlay headroom), **plus workspace bytes**: the
  rootfs overlay and `/workspace` are tmpfs-backed, so every byte the
  workload writes is host RAM, capped at 50% of guest RAM by the init's
  tmpfs mount.

## Env vars

| Var                              | Default                          | Notes                                               |
| -------------------------------- | -------------------------------- | --------------------------------------------------- |
| `FIRECRACKER_BIN`                | `firecracker`                    | VMM binary                                          |
| `FIRECRACKER_KERNEL_PATH`        | `./data/firecracker/vmlinux`     | guest kernel                                        |
| `FIRECRACKER_ROOTFS_PATH`        | `./data/firecracker/rootfs.ext4` | shared read-only rootfs                             |
| `FIRECRACKER_DATA_DIR`           | `./data/firecracker/runs`        | per-run state (tmpfs recommended)                   |
| `FIRECRACKER_SUBNET_CIDR`        | `10.231.0.0/16`                  | /16 pool → per-run /30                              |
| `FIRECRACKER_EGRESS_DENY_CIDRS`  | metadata + RFC1918               | forward-path destinations guests may never reach    |
| `FIRECRACKER_MAX_CONCURRENT_VMS` | `0` (unlimited)                  | admission cap — see _Operational constraints_       |
| `FIRECRACKER_MAX_CONSOLE_BYTES`  | `268435456` (256 MiB)            | per-run console cap — VM killed past it (run fails) |

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
- **No connect-runs**: the VM boots once, driven by the agent workload; a
  sidecar-only workload (connect-run) cannot start. The connect executor
  fails fast (`ConnectNotSupportedError`) — use docker/process for connect
  flows.
- **No jailer, credentials in-guest**: see _Production status_ at the top —
  the backend is experimental until both close.
- Workspace and rootfs overlay are tmpfs-backed → bounded by guest RAM
  (`vmSizing` adds a fixed envelope over the agent budget; see _Operational
  constraints_ for the capacity formula).
