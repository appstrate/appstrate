# Phase 1 — Firecracker Orchestrator Skeleton

**Status:** Ready for implementation
**Prerequisites:** [ADR-007](../adr/ADR-007-firecracker-orchestrator.md) read and understood
**Estimate:** 2-3 days / ~800 LOC including tests
**Phase of:** 5-phase Firecracker rollout (see ADR-007)

---

## 1. Purpose

This phase delivers a **no-op Firecracker orchestrator skeleton** that:

- Compiles and satisfies the full `ContainerOrchestrator` interface
- Is selectable via `RUN_ADAPTER=firecracker`
- Passes a mirror of the existing Docker orchestrator test suite using mocks for the host-privileged operations (KVM, TAP, jailer)
- Ships the iterability foundations required by ADR-007 (§Iterability) so later phases are additive PRs, not refactors

**This phase does NOT:**

- Launch a real microVM (Phase 2)
- Touch the host network or TAP devices for real (Phase 3)
- Parse serial console logs (Phase 4)
- Include snapshots, VM pool, image cache, or real orphan recovery (Phase 5)
- Modify `runtime-pi/` or the sidecar
- Build any CI artifacts (that lives in Phase 2 alongside the first real boot)

The goal is a **testable contract** that the rest of the codebase can rely on, and a skeleton that Phase 2 fills in.

---

## 2. Success criteria

Phase 1 is complete when **all** of the following hold:

1. `bun run check` passes from monorepo root (tsc + eslint + prettier + verify-openapi).
2. `bun test apps/api/test/unit/services/firecracker` passes with ≥ 10 new unit tests.
3. `bun test apps/api/test/integration/services/firecracker-orchestrator.test.ts` passes with the full `ContainerOrchestrator` contract exercised against a `MockFirecrackerHost`.
4. Setting `RUN_ADAPTER=firecracker` in a fresh `.env` boots the platform without crashing; `bun run dev` logs `Firecracker orchestrator initialized (mock host)` and serves `/api/health` 200.
5. Setting `RUN_ADAPTER=firecracker` with `PI_IMAGE` overridden to a non-default value fails boot with a clear RFC 9457 error: `"Tier 4 requires the signed Appstrate runtime image. Custom PI_IMAGE is not supported in this tier."`
6. `getOrchestrator()` returns a `FirecrackerOrchestrator` instance when the mode is `firecracker`.
7. `CHANGELOG.md` entry added under the current unreleased section.
8. No existing Docker/Process tests regress.

---

## 3. File tree to create

All paths are relative to the repo root (`appstrate/`).

```
apps/api/src/services/orchestrator/
├── firecracker-orchestrator.ts        (NEW, ~350 LOC) — the class implementing ContainerOrchestrator
├── index.ts                           (MODIFY) — add "firecracker" case to factory
└── types.ts                           (MODIFY) — add FirecrackerWorkloadHandle, FirecrackerIsolationBoundary types

apps/api/src/services/firecracker/
├── host.ts                            (NEW, ~80 LOC) — FirecrackerHost interface (real/mock split)
├── mock-host.ts                       (NEW, ~150 LOC) — in-memory mock implementation, used in tests + dev-without-KVM
├── jailer.ts                          (NEW, ~50 LOC) — STUB — real impl in Phase 2; Phase 1 throws from all methods
├── tap-manager.ts                     (NEW, ~60 LOC) — STUB — fake TAP names, no real netlink in Phase 1
├── vm-provisioner.ts                  (NEW, ~80 LOC) — VmProvisioner interface + ColdBootProvisioner (stub)
├── audit.ts                           (NEW, ~40 LOC) — emit `vm.provisioned`, `vm.started`, `vm.stopped` via logger
└── constants.ts                       (NEW, ~20 LOC) — sizes, paths, timeouts

apps/api/src/infra/
└── mode.ts                            (MODIFY) — extend getExecutionMode() return type + switch

packages/env/src/
└── index.ts                           (MODIFY) — add FIRECRACKER_* env vars + hard-fail refine for PI_IMAGE

apps/api/src/lib/
└── boot.ts                            (MODIFY) — dispatch Firecracker init alongside Docker init

apps/api/test/unit/services/firecracker/
├── host.test.ts                       (NEW) — MockFirecrackerHost contract tests
├── vm-provisioner.test.ts             (NEW) — ColdBootProvisioner returns expected shape
└── audit.test.ts                      (NEW) — audit events emitted at the right hooks

apps/api/test/integration/services/
└── firecracker-orchestrator.test.ts   (NEW, ~200 LOC) — full ContainerOrchestrator contract against mock host

.env.example                           (MODIFY) — document new env vars
CHANGELOG.md                           (MODIFY) — add unreleased entry
```

---

## 4. Environment variables

Add to `packages/env/src/index.ts` (`envSchema` object):

```ts
// Firecracker (Tier 4, opt-in — requires KVM + CAP_NET_ADMIN on the host)
FIRECRACKER_BINARY: z.string().default("/usr/bin/firecracker"),
FIRECRACKER_JAILER_BINARY: z.string().default("/usr/bin/jailer"),
FIRECRACKER_KERNEL_PATH: z.string().default("/var/lib/appstrate/firecracker/vmlinux"),
FIRECRACKER_ROOTFS_PATH: z.string().default("/var/lib/appstrate/firecracker/runtime-pi.ext4"),
FIRECRACKER_SIDECAR_ROOTFS_PATH: z.string().default("/var/lib/appstrate/firecracker/sidecar.ext4"),
FIRECRACKER_JAILER_CHROOT_BASE: z.string().default("/srv/jailer"),
FIRECRACKER_WORKSPACE_TEMPLATE_PATH: z.string().default("/var/lib/appstrate/firecracker/workspace-template.ext4"),
FIRECRACKER_WORKSPACE_SIZE_GB: z.coerce.number().int().min(1).max(500).default(10),
FIRECRACKER_VM_POOL_SIZE: z.coerce.number().int().min(0).default(2),
FIRECRACKER_BRIDGE_NAME: z.string().default("appstrate-br0"),
FIRECRACKER_BRIDGE_SUBNET: z.string().default("10.200.0.0/16"),
// MVP: mock host when set — no real KVM/TAP syscalls. Defaults to true until Phase 2.
FIRECRACKER_MOCK_HOST: z
  .string()
  .default("true")
  .transform((v) => v === "true" || v === "1"),
```

Extend the existing `RUN_ADAPTER` enum:

```ts
RUN_ADAPTER: z.enum(["docker", "process", "firecracker"]).default("process"),
```

Add a refine after the existing ones to enforce the hard-fail on custom `PI_IMAGE` in Tier 4:

```ts
.refine(
  (env) =>
    env.RUN_ADAPTER !== "firecracker" || env.PI_IMAGE === "appstrate-pi:latest",
  {
    message:
      "Tier 4 (RUN_ADAPTER=firecracker) requires the signed Appstrate runtime image. " +
      "Custom PI_IMAGE is not supported in this tier. Use RUN_ADAPTER=docker for custom images.",
    path: ["PI_IMAGE"],
  },
)
```

Update `.env.example` with a Firecracker section:

```sh
# ─── Firecracker (Tier 4 — Enterprise, KVM required) ─────────
# Enable by setting RUN_ADAPTER=firecracker. Requires /dev/kvm + CAP_NET_ADMIN.
# Firecracker is OFF by default. Tier 4 is opt-in.
# PI_IMAGE cannot be overridden in Tier 4 — use Tier 3 (Docker) for custom images.

# FIRECRACKER_BINARY=/usr/bin/firecracker
# FIRECRACKER_JAILER_BINARY=/usr/bin/jailer
# FIRECRACKER_KERNEL_PATH=/var/lib/appstrate/firecracker/vmlinux
# FIRECRACKER_ROOTFS_PATH=/var/lib/appstrate/firecracker/runtime-pi.ext4
# FIRECRACKER_SIDECAR_ROOTFS_PATH=/var/lib/appstrate/firecracker/sidecar.ext4
# FIRECRACKER_JAILER_CHROOT_BASE=/srv/jailer
# FIRECRACKER_WORKSPACE_TEMPLATE_PATH=/var/lib/appstrate/firecracker/workspace-template.ext4
# FIRECRACKER_WORKSPACE_SIZE_GB=10
# FIRECRACKER_VM_POOL_SIZE=2
# FIRECRACKER_BRIDGE_NAME=appstrate-br0
# FIRECRACKER_BRIDGE_SUBNET=10.200.0.0/16
# FIRECRACKER_MOCK_HOST=true  # Phase 1: always true. Phase 2+: false on KVM-equipped hosts.
```

---

## 5. Execution mode extension

**Modify `apps/api/src/infra/mode.ts`:**

```ts
export function getExecutionMode(): "docker" | "process" | "firecracker" {
  const adapter = getEnv().RUN_ADAPTER;
  if (adapter === "process") return "process";
  if (adapter === "firecracker") return "firecracker";
  return "docker";
}
```

**Modify `apps/api/src/services/orchestrator/index.ts`:**

```ts
import { FirecrackerOrchestrator } from "./firecracker-orchestrator.ts";

function createOrchestrator(): ContainerOrchestrator {
  const mode = getExecutionMode();
  if (mode === "process") return new ProcessOrchestrator();
  if (mode === "firecracker") return new FirecrackerOrchestrator();
  return new DockerOrchestrator();
}
```

---

## 6. Types to add

**Modify `apps/api/src/services/orchestrator/types.ts`** — append at the bottom, do not modify existing types:

```ts
// ─── Firecracker-specific types ──────────────────────────────

/** Opaque handle for a microVM. `id` is the jailer VM id (UUID). */
export interface FirecrackerWorkloadHandle extends WorkloadHandle {
  readonly id: string; // VM id (UUID, used as jailer chroot dir name)
  readonly runId: string;
  readonly role: string; // "sidecar" | "agent"
  readonly socketPath: string; // absolute path to the Firecracker API socket
  readonly chrootPath: string; // absolute path to the jailer chroot for this VM
}

/** Isolation boundary for a run. `id` is the bridge network name (Linux bridge) */
export interface FirecrackerIsolationBoundary extends IsolationBoundary {
  readonly id: string; // bridge name, e.g. "fc-br-{runId-truncated}"
  readonly name: string; // human-readable
  readonly subnet: string; // e.g. "10.200.42.0/30" (one /30 per run — enough for sidecar + agent + gateway)
}
```

Note: these extend the base interfaces. Callers that only rely on `id / runId / role` on the base `WorkloadHandle` don't need to change.

---

## 7. Core interfaces

### 7.1 `apps/api/src/services/firecracker/host.ts`

Abstracts the host-privileged operations. The real implementation ships in Phase 2. Phase 1 implements only the mock.

```ts
// SPDX-License-Identifier: Apache-2.0

export interface FirecrackerHost {
  /** One-time initialization: verify KVM/jailer presence, create bridge, ensure chroot base exists. */
  initialize(): Promise<void>;

  /** Graceful shutdown: stop all running VMs, release bridge, close sockets. */
  shutdown(): Promise<void>;

  /** Create a new VM in the jailer chroot. Returns the API socket path. Does NOT start the VM. */
  createVm(spec: CreateVmSpec): Promise<CreatedVm>;

  /** Start a created VM (sends `InstanceStart` via the Firecracker API socket). */
  startVm(vmId: string): Promise<void>;

  /** Stop a VM (sends `SendCtrlAltDel` or `InstanceHalt`, with fallback to SIGKILL). Idempotent. */
  stopVm(vmId: string, timeoutSeconds?: number): Promise<void>;

  /** Remove the VM artifacts (chroot, socket, drives). Idempotent. */
  removeVm(vmId: string): Promise<void>;

  /** Wait for the VM to exit. Returns the exit code reported by init (via a side-channel file in Phase 2). */
  waitForExit(vmId: string): Promise<number>;

  /** Stream app logs from /dev/hvc1 (mocked in Phase 1, real in Phase 4). */
  streamLogs(vmId: string, signal?: AbortSignal): AsyncGenerator<string>;

  /** List all VM chroots that look orphaned (no active run ref). */
  listCandidateOrphans(): Promise<string[]>;

  /** Create a Linux bridge + subnet for a run. Returns the bridge name. */
  createBridge(name: string, subnet: string): Promise<void>;

  /** Remove a Linux bridge. Idempotent. */
  removeBridge(name: string): Promise<void>;

  /** Attach a new TAP device to a VM and to a bridge. */
  attachTap(vmId: string, bridgeName: string, ip: string): Promise<string>; // returns TAP name

  /** Create a workspace drive (ext4 file) for the run. Uses reflink-clone from template when available. */
  createWorkspaceDrive(runId: string, sizeGb: number): Promise<string>; // returns absolute path

  /** Create an inputs drive (ext4 file containing AFPS + uploads). Returns path + content hash. */
  createInputsDrive(
    runId: string,
    files: { name: string; content: Buffer }[],
  ): Promise<{ path: string; sha256: string }>;

  /** Remove a drive file. Idempotent. */
  removeDrive(path: string): Promise<void>;
}

export interface CreateVmSpec {
  vmId: string;
  role: "sidecar" | "agent";
  kernelPath: string;
  rootfsPath: string;
  workspaceDrivePath?: string; // agent only
  inputsDrivePath?: string; // agent only
  memoryMib: number;
  vcpus: number;
  env: Record<string, string>; // passed via kernel cmdline or MMDS
}

export interface CreatedVm {
  vmId: string;
  socketPath: string;
  chrootPath: string;
}
```

### 7.2 `apps/api/src/services/firecracker/mock-host.ts`

An in-memory implementation. All state is in maps. No filesystem writes outside `/tmp`. Never shells out.

Required behaviors:

- `initialize()` / `shutdown()`: flip an internal `initialized` flag; idempotent.
- `createVm()`: generate a `socketPath = /tmp/fc-mock/{vmId}/firecracker.socket`, create the directory, return the spec.
- `startVm()` / `stopVm()` / `removeVm()`: update internal state map (`created` → `running` → `stopped` → `removed`).
- `waitForExit()`: resolves with `0` when `stopVm` has been called, otherwise hangs until `signal` aborts.
- `streamLogs()`: yields a fixed canned sequence of 3 mock JSON lines then ends.
- `listCandidateOrphans()`: returns the content of the internal state map filtered by age (all VMs created > 5 min ago).
- `createBridge()` / `removeBridge()`: maintain a set.
- `attachTap()`: returns `"tap-mock-{vmId-short}"`.
- `createWorkspaceDrive()` / `createInputsDrive()`: write a 1-byte placeholder file under `/tmp/fc-mock/drives/` and compute a real sha256 of the concatenated file contents for inputs.
- `removeDrive()`: `fs.unlink` + swallow ENOENT.

Keep this simple. The mock exists so `FirecrackerOrchestrator` behavior can be tested end-to-end without any host privileges.

### 7.3 `apps/api/src/services/firecracker/vm-provisioner.ts`

```ts
// SPDX-License-Identifier: Apache-2.0

import type { FirecrackerHost, CreatedVm } from "./host.ts";

export type ProvisioningSource = "cold" | "snapshot";

export interface VmProvisioner {
  /** Provision a VM ready to be started. Source indicates whether a cold boot or snapshot restore was used. */
  provision(spec: ProvisionSpec): Promise<ProvisionedVm>;
}

export interface ProvisionSpec {
  runId: string;
  role: "sidecar" | "agent";
  env: Record<string, string>;
  memoryMib: number;
  vcpus: number;
  workspaceDrivePath?: string;
  inputsDrivePath?: string;
}

export interface ProvisionedVm extends CreatedVm {
  source: ProvisioningSource;
}

/** Phase 1: the only implementation. Cold boots a fresh VM with no snapshot. */
export class ColdBootProvisioner implements VmProvisioner {
  constructor(
    private readonly host: FirecrackerHost,
    private readonly config: { kernelPath: string; agentRootfs: string; sidecarRootfs: string },
  ) {}

  async provision(spec: ProvisionSpec): Promise<ProvisionedVm> {
    const vmId = crypto.randomUUID();
    const rootfs = spec.role === "sidecar" ? this.config.sidecarRootfs : this.config.agentRootfs;
    const vm = await this.host.createVm({
      vmId,
      role: spec.role,
      kernelPath: this.config.kernelPath,
      rootfsPath: rootfs,
      workspaceDrivePath: spec.workspaceDrivePath,
      inputsDrivePath: spec.inputsDrivePath,
      memoryMib: spec.memoryMib,
      vcpus: spec.vcpus,
      env: spec.env,
    });
    return { ...vm, source: "cold" };
  }
}
```

### 7.4 `apps/api/src/services/firecracker/audit.ts`

```ts
// SPDX-License-Identifier: Apache-2.0

import { logger } from "../../lib/logger.ts";
import type { ProvisioningSource } from "./vm-provisioner.ts";

export type VmAuditEvent =
  | {
      type: "vm.provisioned";
      vmId: string;
      runId: string;
      role: string;
      source: ProvisioningSource;
    }
  | { type: "vm.started"; vmId: string; runId: string; role: string }
  | {
      type: "vm.stopped";
      vmId: string;
      runId: string;
      role: string;
      exitCode: number;
      durationMs: number;
    };

export function emitVmAudit(event: VmAuditEvent): void {
  logger.info("firecracker.audit", event);
}
```

Phase 1: audit events go through the platform logger. Phase 5: add a sink to `packages/db` for persistent audit trail.

### 7.5 `apps/api/src/services/firecracker/constants.ts`

```ts
// SPDX-License-Identifier: Apache-2.0

export const SIDECAR_VM_MEMORY_MIB = 128;
export const SIDECAR_VM_VCPUS = 1; // note: Firecracker vCPU count must be integer
export const AGENT_VM_MEMORY_MIB = 512;
export const AGENT_VM_VCPUS = 1;

export const VM_STOP_TIMEOUT_SECONDS = 10;
export const ORPHAN_SCAN_MIN_AGE_SECONDS = 300;

// Per-run subnet is a /30 inside the platform subnet: 4 IPs = network, gateway (bridge), sidecar, agent.
export const PER_RUN_SUBNET_MASK = 30;

export const SIDECAR_STATIC_IP_OFFSET = 2; // x.x.x.2
export const AGENT_STATIC_IP_OFFSET = 3; // x.x.x.3
```

---

## 8. `FirecrackerOrchestrator` — implementation blueprint

The class lives in `apps/api/src/services/orchestrator/firecracker-orchestrator.ts`. It mirrors the structure of `DockerOrchestrator` (read `docker-orchestrator.ts` first — every method in `FirecrackerOrchestrator` should have a 1:1 counterpart).

```ts
// SPDX-License-Identifier: Apache-2.0

import { getEnv } from "@appstrate/env";
import { logger } from "../../lib/logger.ts";
import type { ContainerOrchestrator } from "./interface.ts";
import type {
  WorkloadHandle,
  WorkloadSpec,
  IsolationBoundary,
  SidecarConfig,
  CleanupReport,
  StopResult,
  FirecrackerWorkloadHandle,
  FirecrackerIsolationBoundary,
} from "./types.ts";
import { FirecrackerHost } from "../firecracker/host.ts";
import { MockFirecrackerHost } from "../firecracker/mock-host.ts";
import { ColdBootProvisioner, type VmProvisioner } from "../firecracker/vm-provisioner.ts";
import { emitVmAudit } from "../firecracker/audit.ts";
import {
  SIDECAR_VM_MEMORY_MIB,
  SIDECAR_VM_VCPUS,
  AGENT_VM_MEMORY_MIB,
  AGENT_VM_VCPUS,
  VM_STOP_TIMEOUT_SECONDS,
  PER_RUN_SUBNET_MASK,
  SIDECAR_STATIC_IP_OFFSET,
  AGENT_STATIC_IP_OFFSET,
} from "../firecracker/constants.ts";

export class FirecrackerOrchestrator implements ContainerOrchestrator {
  private readonly host: FirecrackerHost;
  private readonly provisioner: VmProvisioner;
  private readonly activeVms = new Map<string, FirecrackerWorkloadHandle[]>(); // runId → handles

  constructor(host?: FirecrackerHost) {
    const env = getEnv();
    this.host =
      host ?? (env.FIRECRACKER_MOCK_HOST ? new MockFirecrackerHost() : this.realHostOrThrow());
    this.provisioner = new ColdBootProvisioner(this.host, {
      kernelPath: env.FIRECRACKER_KERNEL_PATH,
      agentRootfs: env.FIRECRACKER_ROOTFS_PATH,
      sidecarRootfs: env.FIRECRACKER_SIDECAR_ROOTFS_PATH,
    });
  }

  private realHostOrThrow(): FirecrackerHost {
    throw new Error(
      "Real FirecrackerHost not implemented in Phase 1. Set FIRECRACKER_MOCK_HOST=true (default) or wait for Phase 2.",
    );
  }

  async initialize(): Promise<void> {
    await this.host.initialize();
    logger.info("Firecracker orchestrator initialized", {
      mock: getEnv().FIRECRACKER_MOCK_HOST,
    });
  }

  async shutdown(): Promise<void> {
    await this.host.shutdown();
  }

  async ensureImages(_images: string[]): Promise<void> {
    // No-op in Phase 1: Tier 4 uses signed rootfs artifacts downloaded in Phase 2.
    // PI_IMAGE override is already rejected at env validation — see packages/env.
  }

  async cleanupOrphans(): Promise<CleanupReport> {
    const candidates = await this.host.listCandidateOrphans();
    for (const vmId of candidates) {
      await this.host.removeVm(vmId).catch((err) =>
        logger.warn("Failed to remove orphan VM", {
          vmId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
    return { workloads: candidates.length, isolationBoundaries: 0 };
  }

  async createIsolationBoundary(runId: string): Promise<IsolationBoundary> {
    // Bridge name: `fc-br-{first 8 chars of runId}` — bridges are limited to 15 chars on Linux.
    const shortId = runId.replace(/-/g, "").slice(0, 8);
    const bridgeName = `fc-br-${shortId}`;
    const subnet = this.allocateSubnet(runId);
    await this.host.createBridge(bridgeName, subnet);
    return { id: bridgeName, name: bridgeName, subnet } satisfies FirecrackerIsolationBoundary;
  }

  async removeIsolationBoundary(boundary: IsolationBoundary): Promise<void> {
    await this.host.removeBridge(boundary.id);
  }

  async createSidecar(
    runId: string,
    boundary: IsolationBoundary,
    config: SidecarConfig,
  ): Promise<WorkloadHandle> {
    const subnet = (boundary as FirecrackerIsolationBoundary).subnet;
    const sidecarIp = this.ipWithOffset(subnet, SIDECAR_STATIC_IP_OFFSET);

    const env: Record<string, string> = {
      PORT: "8080",
      PLATFORM_API_URL: config.platformApiUrl,
    };
    if (config.runToken) env.RUN_TOKEN = config.runToken;
    if (config.proxyUrl) env.PROXY_URL = config.proxyUrl;
    if (config.llm) {
      env.PI_BASE_URL = config.llm.baseUrl;
      env.PI_API_KEY = config.llm.apiKey;
      env.PI_PLACEHOLDER = config.llm.placeholder;
    }

    const vm = await this.provisioner.provision({
      runId,
      role: "sidecar",
      env,
      memoryMib: SIDECAR_VM_MEMORY_MIB,
      vcpus: SIDECAR_VM_VCPUS,
    });
    emitVmAudit({
      type: "vm.provisioned",
      vmId: vm.vmId,
      runId,
      role: "sidecar",
      source: vm.source,
    });

    await this.host.attachTap(vm.vmId, boundary.id, sidecarIp);

    const handle: FirecrackerWorkloadHandle = {
      id: vm.vmId,
      runId,
      role: "sidecar",
      socketPath: vm.socketPath,
      chrootPath: vm.chrootPath,
    };
    this.track(handle);
    return handle;
  }

  async createWorkload(spec: WorkloadSpec, boundary: IsolationBoundary): Promise<WorkloadHandle> {
    const subnet = (boundary as FirecrackerIsolationBoundary).subnet;
    const agentIp = this.ipWithOffset(subnet, AGENT_STATIC_IP_OFFSET);
    const sidecarIp = this.ipWithOffset(subnet, SIDECAR_STATIC_IP_OFFSET);

    const workspaceDrivePath = await this.host.createWorkspaceDrive(
      spec.runId,
      getEnv().FIRECRACKER_WORKSPACE_SIZE_GB,
    );

    let inputsDrivePath: string | undefined;
    if (spec.files && spec.files.items.length > 0) {
      const inputs = await this.host.createInputsDrive(spec.runId, spec.files.items);
      inputsDrivePath = inputs.path;
      emitVmAudit({
        type: "vm.provisioned",
        vmId: `inputs-${spec.runId}`,
        runId: spec.runId,
        role: "inputs-drive",
        source: "cold",
      });
    }

    const env: Record<string, string> = {
      ...spec.env,
      SIDECAR_URL: `http://sidecar:8080`, // resolves via /etc/hosts injection (see note)
      SIDECAR_IP: sidecarIp, // fallback direct IP
    };

    const vm = await this.provisioner.provision({
      runId: spec.runId,
      role: "agent",
      env,
      memoryMib: spec.resources.memoryBytes / (1024 * 1024),
      vcpus: Math.max(1, Math.floor(spec.resources.nanoCpus / 1_000_000_000)),
      workspaceDrivePath,
      inputsDrivePath,
    });
    emitVmAudit({
      type: "vm.provisioned",
      vmId: vm.vmId,
      runId: spec.runId,
      role: "agent",
      source: vm.source,
    });

    await this.host.attachTap(vm.vmId, boundary.id, agentIp);

    const handle: FirecrackerWorkloadHandle = {
      id: vm.vmId,
      runId: spec.runId,
      role: spec.role,
      socketPath: vm.socketPath,
      chrootPath: vm.chrootPath,
    };
    this.track(handle);
    return handle;
  }

  async startWorkload(handle: WorkloadHandle): Promise<void> {
    await this.host.startVm(handle.id);
    emitVmAudit({ type: "vm.started", vmId: handle.id, runId: handle.runId, role: handle.role });
  }

  async stopWorkload(handle: WorkloadHandle, timeoutSeconds?: number): Promise<void> {
    const start = Date.now();
    await this.host.stopVm(handle.id, timeoutSeconds ?? VM_STOP_TIMEOUT_SECONDS);
    emitVmAudit({
      type: "vm.stopped",
      vmId: handle.id,
      runId: handle.runId,
      role: handle.role,
      exitCode: 0,
      durationMs: Date.now() - start,
    });
  }

  async removeWorkload(handle: WorkloadHandle): Promise<void> {
    await this.host.removeVm(handle.id);
    this.untrack(handle);
  }

  async waitForExit(handle: WorkloadHandle): Promise<number> {
    return this.host.waitForExit(handle.id);
  }

  async *streamLogs(handle: WorkloadHandle, signal?: AbortSignal): AsyncGenerator<string> {
    yield* this.host.streamLogs(handle.id, signal);
  }

  async stopByRunId(runId: string, timeoutSeconds?: number): Promise<StopResult> {
    const handles = this.activeVms.get(runId);
    if (!handles || handles.length === 0) return "not_found";
    const results = await Promise.allSettled(
      handles.map((h) => this.stopWorkload(h, timeoutSeconds)),
    );
    return results.some((r) => r.status === "fulfilled") ? "stopped" : "already_stopped";
  }

  // ─── Helpers ───

  private track(handle: FirecrackerWorkloadHandle): void {
    const list = this.activeVms.get(handle.runId) ?? [];
    list.push(handle);
    this.activeVms.set(handle.runId, list);
  }

  private untrack(handle: WorkloadHandle): void {
    const list = this.activeVms.get(handle.runId);
    if (!list) return;
    const idx = list.findIndex((h) => h.id === handle.id);
    if (idx >= 0) list.splice(idx, 1);
    if (list.length === 0) this.activeVms.delete(handle.runId);
  }

  private allocateSubnet(runId: string): string {
    // Deterministic /30 allocation inside FIRECRACKER_BRIDGE_SUBNET.
    // Phase 1: naive hash-based allocator. Phase 3 replaces with a real allocator backed by DB.
    const baseSubnet = getEnv().FIRECRACKER_BRIDGE_SUBNET;
    const [base] = baseSubnet.split("/");
    const octets = base.split(".").map(Number);
    // Hash runId to 14 bits for the third octet range (keeps /30 inside /16)
    const hash = [...runId].reduce((acc, c) => (acc * 31 + c.charCodeAt(0)) >>> 0, 0);
    const thirdOctet = hash & 0xff;
    const fourthOctet = ((hash >>> 8) & 0x3f) << 2; // /30 alignment
    return `${octets[0]}.${octets[1]}.${thirdOctet}.${fourthOctet}/${PER_RUN_SUBNET_MASK}`;
  }

  private ipWithOffset(subnet: string, offset: number): string {
    const [base] = subnet.split("/");
    const octets = base.split(".").map(Number);
    return `${octets[0]}.${octets[1]}.${octets[2]}.${octets[3] + offset}`;
  }
}
```

**Important notes about this skeleton:**

- **DNS/hosts injection** is deferred to Phase 2. In Phase 1 the `SIDECAR_URL` env variable is set but `/etc/hosts` isn't actually injected because there's no real VM yet. The mock host accepts the env dict and stores it for test assertions.
- **TAP attachment** is a no-op in the mock (returns a fake name). Real TAP + netlink wiring lands in Phase 3.
- **`waitForExit` exit code** is always 0 from the mock. Real exit-code plumbing via the init binary lands in Phase 4.
- The `allocateSubnet` helper is deliberately hacky. A proper allocator with DB persistence and collision handling lands in Phase 3. This one is good enough to unblock Phase 1 tests.
- `createSidecar` does NOT implement the sidecar pool in Phase 1. Pool lives in Phase 5 (after the first real boot in Phase 2-4 validates end-to-end behavior). This means every Firecracker sidecar in Phase 1 is a fresh cold boot — acceptable because we're testing the contract, not latency.

---

## 9. Boot integration

**Modify `apps/api/src/lib/boot.ts`** — the orchestrator factory already handles mode selection; verify the boot sequence initializes the orchestrator regardless of mode. The current line ~154-174 likely already does:

```ts
const orchestrator = getOrchestrator();
await orchestrator.initialize();
```

No change needed beyond confirming this. If the boot sequence is Docker-specific at any point, factor it out behind the orchestrator interface.

**Cleanup orphans:** the existing boot calls `cleanupOrphans()` on the orchestrator — Firecracker's implementation stubs it via the mock host, which returns an empty list in Phase 1.

---

## 10. Test strategy

### 10.1 Unit tests

File: `apps/api/test/unit/services/firecracker/host.test.ts`

Contract tests for `MockFirecrackerHost`:

- `initialize()` is idempotent
- `createVm()` returns distinct socket paths for distinct `vmId` inputs
- `startVm()` on a non-existent `vmId` throws
- `stopVm()` on an already-stopped VM is a no-op (no throw)
- `waitForExit()` resolves with 0 after `stopVm()` is called
- `streamLogs()` yields exactly 3 lines then completes
- `listCandidateOrphans()` returns VMs older than `ORPHAN_SCAN_MIN_AGE_SECONDS`
- `createInputsDrive()` returns a real sha256 of the concatenated inputs (seed with known bytes → assert known hash)

File: `apps/api/test/unit/services/firecracker/vm-provisioner.test.ts`

- `ColdBootProvisioner` passes through spec → host.createVm
- Returns `source: "cold"`
- Uses sidecar rootfs when `role === "sidecar"`, agent rootfs otherwise

File: `apps/api/test/unit/services/firecracker/audit.test.ts`

- `emitVmAudit` calls `logger.info` with `firecracker.audit` + the event
- Event shapes match the TypeScript discriminated union

### 10.2 Integration tests

File: `apps/api/test/integration/services/firecracker-orchestrator.test.ts`

**These tests run against `MockFirecrackerHost` injected into the orchestrator constructor.** No real Firecracker, no KVM, no root. They must pass in the existing test preload (no changes required to `test/setup/preload.ts` in Phase 1).

Test cases (mirror Docker orchestrator coverage where applicable):

```ts
describe("FirecrackerOrchestrator", () => {
  let orch: FirecrackerOrchestrator;
  let host: MockFirecrackerHost;

  beforeEach(async () => {
    host = new MockFirecrackerHost();
    orch = new FirecrackerOrchestrator(host);
    await orch.initialize();
  });

  afterEach(async () => {
    await orch.shutdown();
  });

  it("initialize is idempotent");
  it("createIsolationBoundary returns a unique bridge name per runId");
  it("createSidecar produces a handle with socketPath + chrootPath");
  it("createSidecar passes platformApiUrl and runToken into env");
  it("createWorkload injects files as an inputs drive when files are present");
  it("createWorkload skips inputs drive when no files");
  it("startWorkload emits vm.started audit event");
  it("stopWorkload emits vm.stopped with durationMs");
  it("stopByRunId stops all tracked handles for that runId");
  it("stopByRunId returns 'not_found' for unknown runId");
  it("cleanupOrphans removes all candidate orphans from the mock host");
  it("removeIsolationBoundary calls host.removeBridge exactly once");
  it("waitForExit returns 0 after stopWorkload");
});
```

### 10.3 End-to-end smoke test

Add a single test under `apps/api/test/integration/run-pipeline/` that:

1. Sets `process.env.RUN_ADAPTER = "firecracker"` + `FIRECRACKER_MOCK_HOST = "true"`
2. Resets the env cache (`_resetCacheForTesting()`)
3. Calls `getOrchestrator()` → asserts it's a `FirecrackerOrchestrator`
4. Calls the full `run-pipeline.ts` flow against a simple agent
5. Asserts logs + audit events are produced

This verifies the factory wiring and the boot contract.

---

## 11. Implementation order (recommended)

Sequential — each step unblocks the next.

1. **Env vars** (`packages/env/src/index.ts`) + `.env.example`. Verify `bun run check` passes.
2. **Types** (`orchestrator/types.ts`) — append the new handle/boundary types.
3. **Constants + audit + provisioner interface** (`services/firecracker/{constants,audit,vm-provisioner}.ts`).
4. **`FirecrackerHost` interface** (`services/firecracker/host.ts`).
5. **`MockFirecrackerHost`** (`services/firecracker/mock-host.ts`) + its unit tests — you should be able to run the host tests in isolation now.
6. **`ColdBootProvisioner`** + its unit test.
7. **`FirecrackerOrchestrator` skeleton** — compile it against the mock host, no tests yet.
8. **Factory update** (`orchestrator/index.ts`) + **mode extension** (`infra/mode.ts`).
9. **Orchestrator integration tests** — the big one.
10. **E2E smoke test** — the factory selects it and boot succeeds.
11. **`CHANGELOG.md`** entry.
12. **Run `bun run check` + `bun test` from monorepo root.** All must pass.

---

## 12. What Phase 2 will add (for context, not this PR)

Phase 1 deliberately stubs everything privileged. Phase 2 adds:

- Real `FirecrackerHost` implementation (`services/firecracker/real-host.ts`) that shells out to `jailer` + `firecracker` binaries.
- Jailer config builder in `services/firecracker/jailer.ts` (cgroup limits, chroot, seccomp profile, netns).
- Real VM lifecycle via HTTP over the API socket (`PUT /boot-source`, `PUT /drives`, `PUT /network-interfaces`, `PUT /machine-config`, `PUT /actions` with `InstanceStart`).
- Custom init binary (Go, ~80 LOC) baked into the rootfs — mounts `/inputs` + `/workspace`, redirects stdout to `/dev/hvc1`, execs the sidecar/agent entrypoint.
- CI workflow `.github/workflows/publish-firecracker-rootfs.yml` that builds + signs + publishes `runtime-pi.ext4` and `sidecar.ext4` to GHCR.
- Platform-side download + cosign verification + content-addressed cache.

None of this is in scope for Phase 1. Reviewers should reject any PR that tries to smuggle it in.

---

## 13. Risks + mitigations (Phase 1 only)

| Risk                                                    | Likelihood    | Mitigation                                                                                                                               |
| ------------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Mock host drifts from real behavior → Phase 2 surprises | High          | Phase 2 PR must include contract tests that run identically against real + mock. If they diverge, the mock is wrong.                     |
| Factory returns wrong orchestrator in tests (env cache) | Medium        | Always call `_resetCacheForTesting()` after mutating `process.env.RUN_ADAPTER` in tests.                                                 |
| `PI_IMAGE` refine blocks valid local dev                | Low           | Refine only fires when `RUN_ADAPTER=firecracker`. Default (`process`) is untouched.                                                      |
| Subnet collision between runs                           | Low (Phase 1) | Naive hash allocator has a ~1% collision rate at 50 concurrent runs. Acceptable for the mock. Phase 3 replaces with DB-backed allocator. |
| TAP name collisions if bridge name collides             | Low           | Bridge name = `fc-br-{8 chars of runId}`. UUID collision at 8 chars is 1 in ~4 billion — acceptable.                                     |

---

## 14. Reviewer checklist

A reviewer merging Phase 1 should verify:

- [ ] All files listed in §3 exist and are under 400 LOC each (keep them focused).
- [ ] `FirecrackerOrchestrator` method signatures match `ContainerOrchestrator` exactly — no new public methods, no skipped methods.
- [ ] No dynamic `import()` or subprocess spawn anywhere in the Phase 1 code. Phase 1 is pure TypeScript + mock state.
- [ ] The `PI_IMAGE` refine is present and triggers only when `RUN_ADAPTER=firecracker`.
- [ ] `getOrchestrator()` in `orchestrator/index.ts` explicitly handles all three modes (no fallthrough to Docker for `firecracker`).
- [ ] Mock host files never write outside `/tmp`.
- [ ] No changes to `runtime-pi/`, `packages/db/`, `packages/ui/`, `packages/core/`, or `apps/web/`. Phase 1 is API-side only.
- [ ] No changes to existing orchestrator files beyond the two explicit modifications in §5-6.
- [ ] Docker orchestrator tests still pass.
- [ ] `CHANGELOG.md` entry is written.
