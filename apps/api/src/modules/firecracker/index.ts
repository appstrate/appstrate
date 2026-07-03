// SPDX-License-Identifier: Apache-2.0

/**
 * Firecracker module — one hardware-isolated microVM per agent run.
 *
 * Contributes TWO execution backends to the orchestrator registry:
 *
 *   - `firecracker` — in-process: the platform host runs the VMs itself.
 *     Activation:
 *       MODULES=oidc,webhooks,mcp,core-providers,firecracker
 *       RUN_ADAPTER=firecracker
 *     Requirements: Linux host with /dev/kvm, the `firecracker` binary
 *     (>= 1.16), and kernel/rootfs artifacts built by
 *     `bun run firecracker:build` (scripts/ in this directory).
 *
 *   - `firecracker-remote` — proxied: every orchestrator call goes over
 *     HTTP to a remote `appstrate-runner` daemon on a KVM-capable host
 *     (issue #819 phase 1; wire protocol in ./runner/protocol.ts).
 *     Activation:
 *       MODULES=oidc,webhooks,mcp,core-providers,firecracker
 *       RUN_ADAPTER=firecracker-remote
 *       FIRECRACKER_RUNNER_URL=... FIRECRACKER_RUNNER_TOKEN=...
 *     The FIRECRACKER_* host vars (kernel/rootfs paths, CIDRs, …) are
 *     NOT needed platform-side in remote mode — they configure the
 *     daemon. init() still parses them (harmless: every field has a
 *     default and no KVM/artifact check happens at init), so a remote
 *     deployment simply leaves them unset.
 *
 * Zero footprint when absent from `MODULES`: no env vars read, no
 * backend registered, no routes, no tables. See
 * docs/architecture/FIRECRACKER.md and README.md next to this file.
 *
 * The module validates its environment (FIRECRACKER_* — owned here, not
 * by @appstrate/env) at init(). Heavy prerequisites (KVM, artifacts,
 * binary version — or, remote, daemon reachability + protocol handshake)
 * are checked in each orchestrator's initialize(), which only runs when
 * RUN_ADAPTER actually selects that backend — a loaded module with a
 * different RUN_ADAPTER must not fail boot on a missing kernel image or
 * an unset FIRECRACKER_RUNNER_URL.
 */

import type { AppstrateModule } from "@appstrate/core/module";
import { FirecrackerOrchestrator } from "./orchestrator.ts";
import { RemoteFirecrackerOrchestrator } from "./remote-orchestrator.ts";
import { getFirecrackerEnv } from "./env.ts";

const firecrackerModule: AppstrateModule = {
  manifest: { id: "firecracker", name: "Firecracker microVM backend", version: "1.0.0" },

  async init() {
    // Fail fast on malformed FIRECRACKER_* values at boot, whether or not
    // this backend is the selected RUN_ADAPTER — a bad CIDR must not wait
    // for the first run to surface. (Remote deployments leave these vars
    // unset — every field has a default, so this parse never requires them.)
    getFirecrackerEnv();
  },

  orchestrators() {
    return {
      firecracker: {
        // The microVM is a hardware virtualization boundary: run
        // credentials never enter the host API process.
        isolatesWorkloads: true,
        // The VM boots exactly once, driven by the agent workload — a
        // sidecar-only launch (connect-runs) would silently never start.
        supportsSidecarOnly: false,
        create: () => new FirecrackerOrchestrator(),
      },
      "firecracker-remote": {
        // The microVM boundary lives on the RUNNER host — run credentials
        // still never enter THIS API process (they transit to the daemon
        // over the authenticated runner link and land inside the VM).
        isolatesWorkloads: true,
        // Same one-shot-VM lifecycle as the in-process backend — a
        // sidecar-only launch (connect-runs) would silently never start.
        supportsSidecarOnly: false,
        create: () => new RemoteFirecrackerOrchestrator(),
      },
    };
  },
};

export default firecrackerModule;
