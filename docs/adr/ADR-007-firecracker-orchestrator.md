# ADR-007: Firecracker MicroVM Orchestrator (Tier 4)

## Status

Proposed — approved for implementation via phased rollout (Phase 1-5).

## Context

Appstrate currently supports two execution backends behind the `ContainerOrchestrator` interface (`apps/api/src/services/orchestrator/interface.ts`):

- **Docker** (`docker-orchestrator.ts`) — production, container-based isolation via Linux namespaces + cgroups
- **Process** (`process-orchestrator.ts`) — dev-only, Bun subprocesses, no isolation

The platform runs user-provided AI agent code, including tools that execute arbitrary shell commands and skills loaded from third-party AFPS packages. Docker provides adequate isolation for the current OSS deployment model, but three requirements push toward a stronger boundary:

1. **Isolation** — Enterprise tenants running multi-tenant workloads need kernel-level separation. A container escape via a kernel exploit crosses into host / other tenants; a microVM escape would require a hypervisor exploit (significantly higher bar).
2. **Compliance** — Customers with SOC2 / ISO 27001 / FedRAMP obligations need attestable, signed artifacts for the runtime, immutable rootfs, per-run audit trails, and cryptographic evidence of isolation.
3. **Cold-start latency** — Firecracker snapshot restore (~50-100ms) beats fresh Docker container cold start (~500-1500ms) for the sidecar. The agent VM cold boot is comparable to Docker today.

The three drivers are compatible if and only if snapshots are taken of **pristine pre-warmed state** (kernel + runtime loaded, before any tenant data enters the VM) and never of dirty runtime state — the AWS Lambda SnapStart pattern.

## Decision

Add a **Firecracker microVM orchestrator** as a third execution backend, opt-in behind a new `RUN_ADAPTER=firecracker` mode. Introduce **Tier 4** as a new progressive infrastructure tier (after Tier 3 / Docker), targeting hosts with KVM + `CAP_NET_ADMIN` available (bare-metal, nested-virt cloud instances, enterprise on-prem).

Docker remains the default production backend. Firecracker is not a replacement; it is a parallel implementation selected per-deployment via env var.

### Core architectural decisions

| #   | Decision                                                                             | Rationale                                                                                                                                                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Use the jailer in all modes** (no raw Firecracker)                                 | Drops privileges, applies cgroup + namespace isolation, chroots the VMM. Officially required for production.                                                                                                                                                                                                |
| 2   | **Two microVMs per run** (sidecar + agent, mirroring Docker)                         | Preserves the existing credential-isolation invariant (ADR-003): agent never sees raw credentials, has no `RUN_TOKEN` / `PLATFORM_API_URL`. Fusing would void the boundary without adding guarantees.                                                                                                       |
| 3   | **Sidecar VM snapshot pool, agent VM cold boot** (MVP)                               | Sidecar state is tenant-agnostic → snapshottable. Agent state is tenant-specific (`AGENT_PROMPT`, package, skills) → fresh boot. Delivers the cold-start win where it matters (sidecar is on the critical path of every request) without refactoring `runtime-pi`.                                          |
| 4   | **Pristine snapshot pattern** for any future agent snapshot                          | Snapshot is taken once per image version, of an empty pre-warmed VM. Tenant data enters only _after_ restore. Preserves isolation + compliance compatibility.                                                                                                                                               |
| 5   | **CI-built, cosign-signed rootfs** (`.ext4`) as the only accepted artifact in Tier 4 | No runtime conversion, no containerd. Pipeline: `buildx --output type=local` → `tar2ext4` → `cosign sign` → GHCR artifact. ~200 LOC vs ~2000 for firecracker-containerd.                                                                                                                                    |
| 6   | **`PI_IMAGE` override hard-fails in Tier 4** (MVP)                                   | A security tier cannot silently ignore user config. Users who need custom images stay on Tier 3. A `CustomImageProvisioner` plugin path is reserved for post-MVP.                                                                                                                                           |
| 7   | **Workspace storage: per-run virtio drive** (ext4, reflink-cloned from template)     | Imprevisible write volume per run (git clone, unzip, LLM-generated files). Fresh file per run = zero inter-tenant leak. reflink-clone is instant (CoW) on XFS/btrfs hosts, `cp` fallback otherwise.                                                                                                         |
| 8   | **File injection: dedicated read-only `/inputs` drive**                              | Inputs (AFPS package, uploads) are separated from the mutable workspace. Drive is hashable → signed audit trail per run. Agent copies what it needs from `/inputs` into `/workspace`.                                                                                                                       |
| 9   | **Networking: per-run bridge + static IPs + `/etc/hosts` injection** (MVP)           | 1:1 mapping with Docker DNS-alias pattern. Agent keeps `fetch("http://sidecar:8080/proxy")` unchanged — zero modification to runtime-pi. Sidecar has a second TAP on an egress bridge with NAT; agent's single TAP is on a dead-end bridge (no route out). vsock migration is roadmapped — see Iterability. |
| 10  | **Logs: two virtio-console devices**                                                 | `ttyS0` carries kernel + init (debug). `/dev/hvc1` carries app stdout (clean JSON-line stream for the platform parser). Kernel noise never interleaves with app output. Pattern used by AWS Lambda, Fly Machines, Modal.                                                                                    |
| 11  | **Init: custom minimal binary (~80 LOC)**, not systemd                               | systemd in a microVM is ~20MB RAM + ~200ms boot for features we don't need. Custom init mounts `/inputs` + `/workspace`, redirects stdout to `hvc1`, execs Bun.                                                                                                                                             |
| 12  | **Orphan recovery: DB registry + jailer chroot sweep**                               | Mirrors `cleanupOrphanedContainers()` in `docker.ts`. Double-sided check: DB rows for active runs → verify jailer chroot + API socket; filesystem scan → verify DB references. Firecracker is stateless; the platform owns reconciliation.                                                                  |

### Threat model

**In scope (Firecracker mitigates):**

- Kernel-exploit-based container escape (VM boundary vs namespace boundary)
- Cross-tenant state leak via shared kernel structures
- Process-level side-channel attacks across tenants on the same host

**Out of scope (Firecracker does not mitigate):**

- Abuse of `authorizedUris` via the sidecar — same attack surface as Docker; sidecar is the boundary
- Compromised sidecar — same blast radius as Docker (agent trusts the sidecar)
- Hypervisor exploits — residual risk, partially mitigated by the jailer + seccomp
- Host compromise — out of scope for any container/VM technology

**Compliance coverage added:**

- Signed rootfs + signed sidecar snapshot → attestable runtime artifacts
- Hashed `/inputs` drive per run → tamper-evident input trail
- Per-VM cgroup accounting (via jailer) → per-tenant resource attribution for billing/audit

## Iterability foundations

These must be posed during Phase 1-2 to keep future optimizations as isolated PRs:

1. **`VmProvisioner` interface** — abstracts "how a VM is prepared" (cold boot vs snapshot restore vs custom). Phase 1 ships `ColdBootProvisioner`. Agent snapshot (deferred) ships as `SnapshotProvisioner` — no orchestrator refactor needed.
2. **Extensible signed manifest** — rootfs manifest is JSON with named hash slots. Adding `agent_snapshot_hash` or `sidecar_snapshot_hash` later is additive.
3. **Mode-agnostic orphan recovery** — scanner doesn't care whether a VM is cold-booted or snapshot-restored; it checks DB reference + jailer chroot + socket liveness.
4. **Granular audit events** — `vm.provisioned`, `vm.started`, `vm.stopped`, each with a `source` field (`"cold" | "snapshot"`). MVP emits `"cold"` always; later modes hook in without schema change.
5. **Sidecar HTTP listener is injectable** — `runtime-pi/sidecar/server.ts` takes a listener factory as a dependency, not `Bun.serve` in hard-code. Swapping to a vsock listener post-MVP = injection change, no rewrite.
6. **`CustomImageProvisioner` plugin path** — image resolution goes through a `RootfsProvider` interface; MVP ships `SignedReleaseProvider` only. Adding custom-image support later = new provider, not a refactor.

## Out of scope for this ADR (deferred decisions)

- **Agent VM snapshot (pre-loaded SDK)** — level 2 of the pristine snapshot strategy. Ship cold boot first, measure, optimize in Phase 5+ if the cold-start budget is not met.
- **Per-agent snapshots** — level 3. Only justifiable with data showing a small set of agents dominates runtime volume.
- **vsock for sidecar↔agent** — post-MVP. Bridge + static IP is SOTA for this MVP. vsock listener abstraction posed in Phase 2 unlocks this later.
- **User-provided custom `PI_IMAGE` in Tier 4** — post-MVP, requires cosign verification of user-signed rootfs. MVP hard-fails.
- **Remote attestation (vTPM, measured boot)** — full enterprise compliance pack. Not natively supported by Firecracker; PR-based, +300-800ms, +5-10% steady-state. Defer until a customer requires it contractually.
- **Production-grade CI tests with real KVM** — MVP relies on mocks. Real-KVM CI requires a dedicated runner (bare-metal or nested-virt GitHub Actions). Post-MVP.

## Consequences

**Positive:**

- Third execution backend unlocks Enterprise tier (KVM-equipped hosts) with kernel-level isolation
- Compliance-grade audit trail: signed runtime, hashed inputs, per-VM resource attribution
- Sidecar cold-start improved by ~500ms-1s (snapshot restore vs fresh container)
- `ContainerOrchestrator` abstraction validated by a third implementation — confirms the interface is load-bearing, not over-fitted
- Phased rollout (Phase 1-5) allows shipping value incrementally; each phase has its own acceptance criteria

**Negative:**

- Three execution backends to maintain (Docker, Process, Firecracker) — test coverage burden, conceptual overhead for contributors
- CI cannot exercise the full Firecracker path without dedicated KVM runners (MVP uses mocks)
- Host requirements narrow the deployment footprint in Tier 4 (KVM + CAP_NET_ADMIN + bridge-capable host)
- Image build pipeline in CI adds a parallel artifact (`rootfs.ext4`) alongside the Docker image
- TAP device management is a new operational concern (leak recovery, unique naming, FD limits)
- Boot kernel + custom init are new maintenance surfaces; kernel CVEs require prompt rebuilds

**Neutral:**

- `runtime-pi` is unchanged in the MVP — agent code, SDK, JSON-line stdout protocol all stay identical
- `ContainerOrchestrator` interface is unchanged — existing callers don't know they're running on Firecracker
- Tier 4 is opt-in, off by default — zero impact on OSS self-hosters on Tier 0-3

## References

- Issue [#159](https://github.com/appstrate/appstrate/issues/159) — original RFC
- [ADR-003](./ADR-003-sidecar-credential-isolation.md) — credential isolation invariant, preserved by decision #2
- [Firecracker design](https://github.com/firecracker-microvm/firecracker/blob/main/docs/design.md)
- [Firecracker jailer](https://github.com/firecracker-microvm/firecracker/blob/main/docs/jailer.md)
- [Firecracker snapshots](https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md)
- [tar2ext4 (Microsoft hcsshim)](https://github.com/microsoft/hcsshim/tree/main/ext4/tar2ext4) — reference for the CI conversion step
- [cosign](https://github.com/sigstore/cosign) — artifact signing
- `docs/specs/PHASE_1_FIRECRACKER_SKELETON.md` — implementation spec for the first phase
