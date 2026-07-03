// SPDX-License-Identifier: Apache-2.0

/**
 * Firecracker module — one hardware-isolated microVM per agent run.
 *
 * ONE topology, one execution backend (`firecracker`): the platform is
 * always containerized (it cannot touch /dev/kvm, TAP devices, or
 * nftables), so every orchestrator call is proxied over HTTP to an
 * `appstrate-runner` daemon running on a KVM-capable host. The daemon
 * embeds the real in-process {@link FirecrackerOrchestrator} — that class
 * is the daemon's engine, not a platform adapter (see ./runner/daemon.ts
 * and ./runner/protocol.ts, the single source of truth for the wire).
 *
 *   platform container ──HTTP──▶ appstrate-runner daemon ──▶ microVMs
 *
 * Activation:
 *     MODULES=oidc,webhooks,mcp,core-providers,firecracker
 *     RUN_ADAPTER=firecracker
 *     FIRECRACKER_RUNNER_URL=...   (http(s) address of the daemon)
 *     FIRECRACKER_RUNNER_TOKEN=... (shared bearer secret, >= 16 chars)
 *
 * The host-side FIRECRACKER_* vars (kernel/rootfs paths, subnet CIDR, …)
 * are daemon-only concerns — the platform never parses them. They live in
 * ./runner/host-env.ts and are read exclusively by the daemon and the dev
 * smoke harness.
 *
 * Zero footprint when absent from `MODULES`: no env vars read, no backend
 * registered, no routes, no tables. See docs/architecture/FIRECRACKER.md
 * and README.md next to this file.
 *
 * Daemon reachability + protocol handshake are checked in the
 * orchestrator's initialize(), which only runs when RUN_ADAPTER actually
 * selects this backend — a loaded module with a different RUN_ADAPTER must
 * not fail boot on an unset FIRECRACKER_RUNNER_URL.
 */

import type { AppstrateModule } from "@appstrate/core/module";
import { RemoteFirecrackerOrchestrator } from "./remote-orchestrator.ts";

const firecrackerModule: AppstrateModule = {
  manifest: { id: "firecracker", name: "Firecracker microVM backend", version: "1.0.0" },

  // Nothing to initialize platform-side: the backend is a lazy HTTP client
  // (FIRECRACKER_RUNNER_* is validated in the orchestrator's initialize(),
  // only when RUN_ADAPTER selects it) and the host-side FIRECRACKER_* vars
  // are the daemon's concern, not the platform's.
  async init() {},

  orchestrators() {
    return {
      firecracker: {
        // The microVM boundary lives on the RUNNER host — run credentials
        // never enter THIS API process (they transit to the daemon over
        // the authenticated runner link and land inside the VM).
        isolatesWorkloads: true,
        // The VM boots exactly once, driven by the agent workload — a
        // sidecar-only launch (connect-runs) would silently never start.
        supportsSidecarOnly: false,
        create: () => new RemoteFirecrackerOrchestrator(),
      },
    };
  },
};

export default firecrackerModule;
