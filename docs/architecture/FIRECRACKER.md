# Firecracker Orchestrator (`RUN_ADAPTER=firecracker`)

One **microVM per run**. The isolation boundary the platform cares about is a
hardware virtualization boundary (KVM) around the whole run — stronger host
protection than a container: a workload escape compromises a throwaway guest
kernel, not the host.

## One topology — platform → `appstrate-runner` daemon

The platform is always containerized (Coolify / docker-compose) — it cannot
own KVM, TAP devices, or nftables. So there is a **single** supported topology:
the `firecracker` backend is a `RunOrchestrator` HTTP client
(`RemoteFirecrackerOrchestrator`) that proxies every call to a small daemon
(`bun run firecracker:runner`, systemd on a KVM host). The daemon embeds the
in-process `FirecrackerOrchestrator` — that class is the daemon's **engine**,
not a platform adapter — behind a token-authenticated JSON/NDJSON protocol
(`runner/protocol.ts`, versioned). This is the standard production split (AWS
MicroManager, Fly.io flyd, E2B orchestrator): the control plane never touches
KVM; the privileged surface lives in a rarely-released host daemon.

## Activation — built-in module

The backend ships as the built-in `firecracker` module
(`apps/api/src/modules/firecracker/`), **not** in the default `MODULES` set.
Zero footprint when absent: no env vars read, no backend registered.

```sh
# Platform (container)
MODULES=oidc,webhooks,mcp,core-providers,firecracker
RUN_ADAPTER=firecracker
FIRECRACKER_RUNNER_URL=http://<runner-host>:3100
FIRECRACKER_RUNNER_TOKEN=<shared secret, >=16 chars>
```

Setting `RUN_ADAPTER=firecracker` without the module is a fatal boot error
listing the registered backends; a stale `RUN_ADAPTER=firecracker-remote`
(the id before the in-process backend was removed) gets a targeted "renamed to
`firecracker`" error. Platform-side only `FIRECRACKER_RUNNER_URL`/`_TOKEN` are
read (validated lazily, on the first `initialize()`). The host-side
`FIRECRACKER_*` variables (kernel/rootfs, subnet CIDR, …) are **daemon-only** —
never parsed platform-side. None of these are part of the `@appstrate/env`
schema.

## Daemon (`appstrate-runner`)

Runs on the KVM host. Owns two env schemas — its listen/link config
(`FIRECRACKER_RUNNER_*`, `runner/env.ts`) and the engine's host config
(`FIRECRACKER_*`, `runner/host-env.ts`). It boots on a bare host with **only**
those variables — nothing in its dependency closure imports `@appstrate/env`,
so no `BETTER_AUTH_SECRET`/`CONNECTION_ENCRYPTION_KEY`/`UPLOAD_SIGNING_SECRET`
are required (the closure uses an env-free pino logger, `runner/logger.ts`).

Guests reach the platform at `FIRECRACKER_RUNNER_PLATFORM_URL` (IPv4 literal —
guests have no DNS); the daemon opens an explicit nft accept for exactly that
ip:port ahead of the egress-deny CIDRs. Capabilities: `isolatesWorkloads: true`
(the VM lives on the runner host, credentials never enter the platform
process), `supportsSidecarOnly: false`.

**Transport & auth.** The wire carries run tokens and credential bundles
(`POST /v1/sidecars`), so keep the link trusted: same machine, private network,
or TLS via a reverse proxy in front of the daemon. Auth is a single shared
token compared in constant time; run **one platform per daemon** (the orphan
sweep is daemon-wide). The protocol is JSON over HTTP (`runner/protocol.ts`,
versioned — the client refuses a daemon speaking another major version); logs
stream as NDJSON with reconnect-and-skip and exit codes long-poll.

## Installing the daemon — `appstrate runner install` (issue #819, phase 3)

The supported install path is the **CLI**, not a manual checkout. On a fresh
KVM host:

```sh
# One-liner (downloads the CLI, verifies it, then execs `runner install`):
curl -fsSL https://get.appstrate.dev/runner | sudo bash -s -- \
  --platform-url http://<PLATFORM_IPV4>:3000

# Or, if the CLI is already installed:
sudo appstrate runner install --platform-url http://<PLATFORM_IPV4>:3000
```

`appstrate runner install` (`apps/cli/src/commands/runner.ts`):

1. **Preflight** — Linux, `/dev/kvm` (read+write), `nft`, `ip`, supported arch.
   Every failed check prints a one-line remedy; the install aborts rather than
   crash-looping the daemon later.
2. **Download + verify** the compiled daemon binary
   (`appstrate-runner-<arch>`, published by `release.yml`, verified against the
   release's **minisign-signed `checksums.txt`** — the same signed trust chain
   the CLI itself ships under, so a tampered mirror cannot swap both the binary
   and its digest) → `/usr/local/bin/appstrate-runner`, and the pinned upstream
   **firecracker** binary (v1.16.0, verified against its own upstream
   `.tgz.sha256.txt`) → `<data-dir>/bin/firecracker`.
3. **Token** — reuses an existing one from `/etc/appstrate-runner/env`, else
   generates 48 hex chars and prints it once. Set the same value as
   `FIRECRACKER_RUNNER_TOKEN` on the platform.
4. **Config + unit** — writes `/etc/appstrate-runner/env` (0600) and a hardened
   systemd unit (`ProtectSystem=strict`, `ReadWritePaths=<data-dir>`,
   `Restart=always`; PATH corrected to include `/usr/sbin`+`/sbin` because the
   daemon spawns `ip`/`nft`/`sysctl`/`mkfs.ext4`/`debugfs` by bare name), then
   `systemctl daemon-reload && enable --now`.
5. **Verify + firewall** — polls `/v1/health`, then prints the exact
   `ufw`/`firewalld` command to open the daemon port for the platform.

Guest artifacts (kernel + rootfs) are NOT downloaded by the CLI — the daemon
resolves them itself at first boot (see below), so `runner install` returns as
soon as the unit is up and the artifact download proceeds in the background
(`runner doctor` / `runner logs -f` show progress).

**`bun build --compile` note.** The daemon binary embeds a Bun runtime + its JS
closure; it has no N-API native modules, and nothing in the closure reads a
source-relative path (`import.meta.dir`/`__dirname`) or dynamic-imports at
runtime — the in-guest supervisor is baked into the rootfs by CI, not bundled.
The one host-relative surface is the engine's `FIRECRACKER_*` path defaults
(`./data/firecracker/*`, cwd-relative). Under systemd the working directory is
`/`, so `runner install` pins them to ABSOLUTE paths under the data dir in the
generated env file (and the unit sets `WorkingDirectory`), decoupling the
compiled daemon from its launch cwd.

Day-2 verbs: `appstrate runner doctor` (preflight, systemd state, `/v1/health`,
and installed-artifacts version/protocol — `--json` for scripts); `runner
update` (re-download the daemon binary for this CLI's version, verify,
atomic-swap, restart); `runner status`; `runner logs [-f]`.

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

Two artifacts, shared by all runs, validated at `initialize()`:

- **rootfs** (`FIRECRACKER_ROOTFS_PATH`) — `apps/api/src/modules/firecracker/scripts/Dockerfile.rootfs`:
  the `appstrate-pi` image + the compiled sidecar binary + guest init/
  supervisor + nftables/setpriv, exported and converted with `mkfs.ext4 -d`.
  Arch-specific.
- **kernel** (`FIRECRACKER_KERNEL_PATH`) — built by
  `apps/api/src/modules/firecracker/scripts/build-kernel.sh` (Docker, no host toolchain): pinned
  6.1 kernel with the Firecracker project's own CI config as base, plus
  `NF_TABLES`/`NF_TABLES_INET`/`NETFILTER_XT_MATCH_OWNER`. The stock
  Firecracker CI kernels canNOT be used as-is — runtime-verified to lack
  nftables AND the iptables owner match entirely (everything `=y`, nothing
  loadable), which would break the in-guest uid firewall.

### Daemon install — download, don't build (issue #819, phase 2)

A released daemon does **not** build artifacts on the host. At boot, BEFORE
`initialize()`, `runner/artifacts.ts` resolves the kernel + rootfs:

1. **Skip** when the files already exist and — if `FIRECRACKER_ARTIFACTS_VERSION`
   is pinned — the on-disk version marker matches. Otherwise:
2. **Download** `firecracker-artifacts-manifest.json`, `vmlinux-<arch>`, and
   `rootfs-<arch>.ext4.zst` from `FIRECRACKER_ARTIFACTS_BASE_URL` (default: this
   repo's GitHub Releases — `latest`, or `download/v<version>` when pinned).
3. **Verify** SHA256 while streaming; **decompress** the rootfs with Bun's
   native zstd (`Bun.zstdDecompressSync` — no external `zstd` binary, no extra
   dependency) and verify the DECOMPRESSED digest against the manifest.
4. **Install atomically** (tmp write + rename) into the engine's paths and
   write a version marker.

Failure policy: a network failure with artifacts already present → **warning**,
boot continues on the existing files; missing artifacts + failed download →
**fatal** (actionable message). A **guest-protocol mismatch** (manifest
`guest_protocol` ≠ daemon `GUEST_PROTOCOL_VERSION`, exported from
`runner/artifacts.ts`) or a **checksum mismatch** is ALWAYS fatal — the daemon
never boots artifacts it cannot drive, nor a corrupt/tampered asset. The
`guest_protocol` couples the daemon engine (config drive, exit-marker protocol,
rootfs layout) to the artifacts; its bump rules are documented beside the
constant.

Publication: the `firecracker-artifacts` job in `.github/workflows/release.yml`
(matrix `{x86_64, aarch64}`, native runners) reuses `build-kernel.sh` /
`build-rootfs.sh`, zstd-compresses the rootfs, and attaches the assets + the
combined manifest to each `v*` GitHub Release.

**Dev**: iterate on `guest/` with `bun run firecracker:build`, then set
`FIRECRACKER_ARTIFACTS_LOCAL=1` to skip the resolver entirely.

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
- **Admission cap.** `FIRECRACKER_MAX_CONCURRENT_VMS` (default `16`; `0` =
  unlimited): at the cap, `createIsolationBoundary` fails the run fast instead
  of overcommitting host RAM with another VM.
- **Console ceiling.** The serial console (guest kernel + supervisor + full
  workload stdout) appends unbounded; a per-VM watchdog kills the VM — the
  run fails — once `console.log` exceeds `FIRECRACKER_MAX_CONSOLE_BYTES`.
- **Capacity planning.** Per-run guest RAM =
  `agent MiB + 512 MiB` (256 MiB sidecar — dropped for skipSidecar runs —
  plus 256 MiB kernel/init/overlay headroom), **plus workspace bytes**: the
  rootfs overlay and `/workspace` are tmpfs-backed, so every byte the
  workload writes is host RAM, capped at 50% of guest RAM by the init's
  tmpfs mount.

## Observability — debugging a failed run

The daemon deletes the per-run workspace (with its `console.log`) at
teardown, and a run's crash is exactly when you need that console. The
teardown path itself is therefore the observability surface:

- **Structured teardown log.** Every microVM destruction emits
  `Firecracker workload destroyed` with `{ runId, reason, exitMarkerFound,
uptimeMs }`. `reason` is derived from the call path: `finalize` (run
  ended, `removeIsolationBoundary`), `watchdog-kill` (platform stopped the
  run by id via `stopByRunId` — the stall watchdog and user cancel share
  this route), `orphan-sweep` (boot-time reclamation of a crashed
  predecessor), `shutdown` (daemon stopping), or `crash` (VMM exited
  non-zero without an intentional stop, incl. the console-ceiling kill).
  `exitMarkerFound` is the nonce-authenticated supervisor exit marker — the
  same signal `waitForExit` trusts. There is no longer a silent gap between
  "microVM booted" and cleanup.
- **Console retention.** Before the workspace is deleted, the last 256 KiB
  of `console.log` is copied to
  `<FIRECRACKER_DATA_DIR>/../console-archive/<runId>.log`; the archive dir
  is pruned to the 100 most recent files. Archiving is best-effort — a
  failure only warns, it never fails a teardown. Orphan-swept runs are
  archived too (their exit-marker nonce died with the previous daemon, so
  `exitMarkerFound` is reported `false`).
- **Console API.** `GET /v1/workloads/:id/console?tailBytes=N` (bearer-
  authed like every other route; `N` clamped to ≤ 256 KiB, default 64 KiB;
  `:id` = run id) serves the live console while the VM runs, else the
  archive; `404` when neither exists. The `:id` is charset-restricted so it
  can never traverse out of the archive directory.
- **Abnormal-exit surfacing.** When `waitForExit` resolves non-zero, the
  platform `RemoteFirecrackerOrchestrator` fetches a ~2 KiB console tail via
  the API above and records it as a `system` / `firecracker_console` run-log
  row (visible in the UI — the log detail the platform records for the run).
  Fully guarded and time-boxed: a fetch failure never blocks the run's
  finalize.
- **Boot-phase liveness.** The platform stall watchdog finalises a run whose
  `runs.last_heartbeat_at` slips past `RUN_STALL_THRESHOLD_SECONDS`
  (default 60 s). A slow-booting guest has not yet emitted its first sink
  event, so the platform records a **synthetic** heartbeat on the same
  column every 15 s during the boot window — but only while the daemon
  confirms the VMM is alive (`POST /v1/workloads/status`). It stops the
  instant real events flow (`last_event_sequence > 0`), the sink closes, or
  the daemon reports the VMM dead — so a genuinely hung or dead VM is never
  masked. This removes the historical "watchdog kills a healthy,
  slow-booting run" class (see the Lima `RUN_STALL_THRESHOLD=300` workaround).
- **Boot-time guest-path self-verification.** Immediately after the orphan
  sweep and _before_ the port opens, the daemon probes whether a guest could
  actually reach `FIRECRACKER_RUNNER_PLATFORM_URL` through the freshly-applied
  nft policy (`runner/net-probe.ts`) — a namespaced guest-path probe plus a
  forward-path reachability check. The silent DNAT drop that once cost hours
  of `tcpdump` becomes a one-line boot diagnostic. The verdict is reported
  verbatim on `GET /v1/health` as `platformReachable` / `guestPathVerified`
  (the platform surfaces it in the module health check). `FIRECRACKER_NET_VERIFY`
  decides severity: `warn` (default) logs a proven drop and boots anyway;
  `strict` refuses to start. An _unverifiable_ path (the probe couldn't reach
  a verdict) is always non-fatal — only a proven drop trips `strict`.

## Env vars

The daemon owns two schemas, neither part of `@appstrate/env` — the daemon
boots on a bare KVM host with only these variables.

### Daemon listen/link — `FIRECRACKER_RUNNER_*` (`runner/env.ts`)

| Variable                          | Default   | Notes                                                                                                                                                                  |
| --------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FIRECRACKER_RUNNER_TOKEN`        | —         | REQUIRED, ≥16 chars. Shared bearer secret; every request must present it. Must match the platform's `FIRECRACKER_RUNNER_TOKEN`                                         |
| `FIRECRACKER_RUNNER_PORT`         | `3100`    | Daemon listen port                                                                                                                                                     |
| `FIRECRACKER_RUNNER_HOST`         | `0.0.0.0` | Bind narrowly / firewall the port — the launch spec carries run credentials                                                                                            |
| `FIRECRACKER_RUNNER_PLATFORM_URL` | —         | REQUIRED. `http(s)://<IPv4>[:port]` guests use to reach the platform (IP literal — no DNS in guests). The daemon opens an explicit nft accept for exactly this ip:port |

### Engine host config — `FIRECRACKER_*` (`runner/host-env.ts`)

| Var                              | Default                          | Notes                                                                   |
| -------------------------------- | -------------------------------- | ----------------------------------------------------------------------- |
| `FIRECRACKER_BIN`                | `firecracker`                    | VMM binary                                                              |
| `FIRECRACKER_KERNEL_PATH`        | `./data/firecracker/vmlinux`     | guest kernel                                                            |
| `FIRECRACKER_ROOTFS_PATH`        | `./data/firecracker/rootfs.ext4` | shared read-only rootfs                                                 |
| `FIRECRACKER_DATA_DIR`           | `./data/firecracker/runs`        | per-run state (tmpfs recommended)                                       |
| `FIRECRACKER_SUBNET_CIDR`        | `10.231.0.0/16`                  | /16 pool → per-run /30                                                  |
| `FIRECRACKER_EGRESS_DENY_CIDRS`  | metadata + RFC1918               | forward-path destinations guests may never reach                        |
| `FIRECRACKER_MAX_CONCURRENT_VMS` | `16` (`0` = unlimited)           | admission cap — see _Operational constraints_                           |
| `FIRECRACKER_MAX_CONSOLE_BYTES`  | `268435456` (256 MiB)            | per-run console cap — VM killed past it (run fails)                     |
| `FIRECRACKER_ARTIFACTS_BASE_URL` | this repo's GH Releases          | guest-artifact download base (mirror for air-gapped)                    |
| `FIRECRACKER_ARTIFACTS_VERSION`  | `latest` / on-disk               | pin a release; unset skips download when present                        |
| `FIRECRACKER_ARTIFACTS_LOCAL`    | unset                            | `=1` skips the resolver (dev, local builds)                             |
| `FIRECRACKER_NET_VERIFY`         | `warn`                           | Boot guest→platform path probe: `warn` logs a drop, `strict` fails boot |

## Development on macOS

Firecracker requires KVM; Apple Silicon (M3+, macOS 15+) provides it through
nested virtualization inside a Lima "vz" VM (verified: microVM boots in
~1.9 s). One entrypoint:

```sh
bun run test:firecracker
```

macOS: creates/starts the `appstrate-fc-dev` Lima VM
(`apps/api/src/modules/firecracker/scripts/dev/lima.yaml` — docker, firecracker, bun, e2fsprogs
provisioned), rsyncs the repo to the VM's own disk (the host mount is
read-only — installing Linux node_modules into the host tree would break the
macOS checkout), then runs `vm-smoke.sh`. Linux/CI: runs `vm-smoke.sh`
directly. The suite = artifact build (cached) + firecracker unit tests +
`apps/api/src/modules/firecracker/scripts/dev/smoke.ts`, which drives the real orchestrator
lifecycle (TAP → config drive → boot → uid drop → exit marker → teardown)
with a trivial agent argv.

## Module layout

Files under `apps/api/src/modules/firecracker/`:

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
| `runner/net-probe.ts`                        | Boot-time guest→platform path probe (health `guestPathVerified`)      |
| `runner/logger.ts`                           | Env-free pino logger for the daemon closure (no `@appstrate/env`)     |
| `runner/server.ts`                           | Hono app factory (DI orchestrator — unit-testable)                    |
| `runner/daemon.ts`                           | Entrypoint (`bun run firecracker:runner`)                             |
| `scripts/`                                   | Kernel/rootfs build (`Dockerfile.rootfs`, `build-*.sh`)               |
| `scripts/dev/`                               | Lima dev VM + smoke suite                                             |

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
