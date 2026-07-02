// SPDX-License-Identifier: Apache-2.0

/**
 * Firecracker module — one hardware-isolated microVM per agent run.
 *
 * Contributes the `firecracker` execution backend to the orchestrator
 * registry (`RUN_ADAPTER=firecracker`). Zero footprint when absent from
 * `MODULES`: no env vars read, no backend registered, no routes, no
 * tables. Activation:
 *
 *   MODULES=oidc,webhooks,mcp,core-providers,firecracker
 *   RUN_ADAPTER=firecracker
 *
 * Requirements: Linux host with /dev/kvm, the `firecracker` binary
 * (>= 1.16), and kernel/rootfs artifacts built by
 * `bun run firecracker:build` (scripts/ in this directory). See
 * docs/architecture/FIRECRACKER.md and README.md next to this file.
 *
 * The module validates its environment (FIRECRACKER_* — owned here, not
 * by @appstrate/env) at init(). Heavy prerequisites (KVM, artifacts,
 * binary version) are checked in the orchestrator's initialize(), which
 * only runs when RUN_ADAPTER actually selects this backend — a loaded
 * module with a different RUN_ADAPTER must not fail boot on a missing
 * kernel image.
 */

import type { AppstrateModule } from "@appstrate/core/module";
import { FirecrackerOrchestrator } from "./orchestrator.ts";
import { getFirecrackerEnv } from "./env.ts";

const firecrackerModule: AppstrateModule = {
  manifest: { id: "firecracker", name: "Firecracker microVM backend", version: "1.0.0" },

  async init() {
    // Fail fast on malformed FIRECRACKER_* values at boot, whether or not
    // this backend is the selected RUN_ADAPTER — a bad CIDR must not wait
    // for the first run to surface.
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
    };
  },
};

export default firecrackerModule;
