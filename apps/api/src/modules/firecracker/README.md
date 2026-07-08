# Firecracker module

One hardware-isolated [Firecracker](https://firecracker-microvm.github.io/) microVM per agent run (`RUN_ADAPTER=firecracker`). The platform is always containerized, so it cannot touch `/dev/kvm`, TAP devices, or nftables: the built-in `firecracker` backend is an HTTP client (`RemoteFirecrackerOrchestrator`) that proxies every orchestrator call to an `appstrate-runner` daemon on a KVM-capable host. The daemon embeds the real in-process `FirecrackerOrchestrator` engine. Opt-in — **not** in the default `MODULES` set; zero footprint when absent.

## Quickstart

Platform side (the container) reads only these four variables:

```sh
MODULES=oidc,webhooks,mcp,core-providers,@appstrate/module-chat,firecracker   # add "firecracker"
RUN_ADAPTER=firecracker
FIRECRACKER_RUNNER_URL=http://<runner-host>:3100
FIRECRACKER_RUNNER_TOKEN=<shared secret, >=16 chars>
```

The host-side `FIRECRACKER_*` / `FIRECRACKER_RUNNER_*` variables are **daemon-only** — never parsed platform-side. Install the daemon on a fresh KVM host with the CLI (no checkout, no bun, no on-host build):

```sh
curl -fsSL https://get.appstrate.dev/runner | sudo bash -s -- \
  --platform-url http://<PLATFORM_IPV4>:3000
```

Set the same token as `FIRECRACKER_RUNNER_TOKEN` on the platform. Day-2: `appstrate runner {doctor,update,status,logs}`.

## Dev loop

- **macOS / Lima + smoke suite**: `bun run test:firecracker` — creates the `appstrate-fc-dev` Lima VM (nested KVM), then drives the real orchestrator lifecycle (`scripts/dev/`). On Linux/CI it runs the smoke suite directly.
- **Iterating on `guest/`** (supervisor, init): `bun run firecracker:build`, then `FIRECRACKER_ARTIFACTS_LOCAL=1` to skip the boot-time artifact resolver.
- **Manual daemon**: `bun run firecracker:runner` (the CLI install path is preferred for anything but development).

## Canonical documentation

`docs/architecture/FIRECRACKER.md` is the authoritative ops/architecture reference — topology, install flow, guest artifacts, env-var tables (both schemas), security posture, observability, and module layout.
