# Firecracker module

One hardware-isolated [Firecracker](https://firecracker-microvm.github.io/) microVM per agent run (`RUN_ADAPTER=firecracker`). The platform is always containerized, so it cannot touch `/dev/kvm`, TAP devices, or nftables: the built-in `firecracker` backend is an HTTP client (`RemoteFirecrackerOrchestrator`) that proxies every orchestrator call to an `appstrate-runner` daemon on a KVM-capable host. The daemon embeds the real in-process `FirecrackerOrchestrator` engine. Opt-in — **not** in the default `MODULES` set; zero footprint when absent.

## Quickstart

Platform side (the container) reads only these variables (plus the optional `FIRECRACKER_RUNNER_ALLOW_PLAINTEXT`, below):

```sh
MODULES=oidc,webhooks,mcp,core-providers,firecracker   # add "firecracker"
RUN_ADAPTER=firecracker
FIRECRACKER_RUNNER_URL=https://<runner-host>:3100      # https for split-host; see runbook below
FIRECRACKER_RUNNER_TOKEN=<shared secret, >=16 chars>
SINK_LISTENER_PORT=3310                                # guest-facing sink listener — REQUIRED (see below)
```

The wire carries per-run credentials, so a plaintext `http://` URL to a non-loopback host is **refused — the boot fails hard**. Same-host installs (platform container → host daemon over the Docker bridge) set `FIRECRACKER_RUNNER_ALLOW_PLAINTEXT=1` to opt out explicitly (the platform then logs a loud warning); split-host deployments put TLS in front of the daemon instead. Details in the runbook below.

The host-side `FIRECRACKER_*` / `FIRECRACKER_RUNNER_*` variables are **daemon-only** — never parsed platform-side. Install the daemon on a fresh KVM host with the CLI (no checkout, no bun, no on-host build):

```sh
curl -fsSL https://get.appstrate.dev/runner | sudo bash -s -- \
  --platform-url http://<PLATFORM_IPV4>:3310   # the SINK listener port, not the API port
```

Set the same token as `FIRECRACKER_RUNNER_TOKEN` on the platform. Day-2: `appstrate runner {doctor,update,status,logs}`.

## Guest-facing surface — sink listener only (mandatory)

The host/guest nftables rules scope guest→platform egress to a single ip:port — whatever `FIRECRACKER_RUNNER_PLATFORM_URL` points at. If that were the main API port, guests could reach **every** platform route and isolation would rest solely on per-route auth (SSRF surface). So the firecracker backend REQUIRES the dedicated sink listener — `initialize()` refuses to boot the platform without `SINK_LISTENER_PORT` set:

1. `SINK_LISTENER_PORT` (default pick `3310`) boots a second minimal listener (`apps/api/src/lib/sink-server.ts` — the authoritative route list) mounting only the run sink surface workloads call; everything else 404s.
2. The daemon's `FIRECRACKER_RUNNER_PLATFORM_URL` points at that port (`--platform-url http://<PLATFORM_IPV4>:3310`). The existing firewall port scoping then admits the sink surface only — no other daemon-side change needed.

**The installer handles both sides**: a fresh `appstrate install --run-adapter firecracker` writes `SINK_LISTENER_PORT=3310` into the platform `.env` (the compose templates publish the port) and points the runner install's `--platform-url` at it. An upgrade re-run adds the missing `SINK_LISTENER_PORT` and prints the daemon follow-up.

**Rollout order on upgrades** (pre-sink-listener deployments): platform first — the main API port keeps serving the sink routes, so runs keep working — then repoint the daemon's `FIRECRACKER_RUNNER_PLATFORM_URL` at the sink port and restart it. Until the daemon is repointed the platform logs a port-mismatch warning at initialize (the daemon targets a port that is not the sink listener); a stale daemon URL after a platform port change would otherwise surface only as run-stall watchdog failures.

## Dev loop

- **macOS / Lima + smoke suite**: `bun run test:firecracker` — creates the `appstrate-fc-dev` Lima VM (nested KVM), then drives the real orchestrator lifecycle (`scripts/dev/`). On Linux/CI it runs the smoke suite directly.
- **Iterating on `guest/`** (supervisor, init): `bun run firecracker:build`, then `FIRECRACKER_ARTIFACTS_LOCAL=1` to skip the boot-time artifact resolver.
- **Manual daemon**: `bun run firecracker:runner` (the CLI install path is preferred for anything but development).

## Production host runbook

Hardening steps for a production runner host. The daemon checks the first three at boot (`runner/host-hygiene.ts`) and logs one warning per violation — a clean boot log means they are done.

- **Disable SMT** — guests on sibling hyperthreads can mount cross-thread side-channel attacks. Boot with the `nosmt` kernel parameter, or at runtime: `echo off > /sys/devices/system/cpu/smt/control`.
- **Disable swap** — swapped guest memory writes per-run credentials to persistent storage. `swapoff -a`, then remove swap entries from `/etc/fstab` (and any swap systemd units) so it stays off across reboots.
- **Disable KSM** — same-page merging leaks guest memory contents across VMs via dedup timing: `echo 0 > /sys/kernel/mm/ksm/run`.
- **Transport (platform↔daemon)** — the wire carries the bearer token and per-run credentials:
  - _Same host_ (platform container → host daemon over the Docker bridge): plaintext is acceptable — the traffic never leaves the machine — but the URL host is non-loopback, so set `FIRECRACKER_RUNNER_ALLOW_PLAINTEXT=1` (platform-side) to opt out of the default refusal (a loud warning is logged instead). Loopback URLs (`127.0.0.1`/`localhost`) need no opt-out.
  - _Split host_: TLS is required — put a TLS reverse proxy in front of the daemon and use `https://` in `FIRECRACKER_RUNNER_URL`. The platform refuses plaintext non-loopback URLs (hard boot failure); never set the opt-out for a link that leaves the machine.

## Canonical documentation

`docs/architecture/FIRECRACKER.md` is the authoritative ops/architecture reference — topology, install flow, guest artifacts, env-var tables (both schemas), security posture, observability, and module layout.
