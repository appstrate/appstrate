# Phase 5 — Production Hardening (Snapshots, Pool, Orphan Recovery, Observability)

> **⚠️ Spec non figée.** Ce document capture l'intention et les décisions prises en Phase 0 (voir [ADR-007](../adr/ADR-007-firecracker-orchestrator.md)). L'agent qui implémente cette phase est **invité à challenger** toute décision qui s'avère inapplicable, sous-optimale, ou rendue obsolète par ce qui a été appris en Phases 1-4. C'est la phase la plus ouverte — les mesures de perf et de stabilité collectées en Phases 2-4 doivent **guider les priorités** ici plutôt que suivre aveuglément le plan. Toute déviation majeure doit être notée dans le PR et synchronisée avec l'ADR.

**Status:** Pending Phases 1-4 completion
**Prerequisites:** Phases 1-4 merged. Real VMs booting, networking functional, logs + drives wired. At least 1 week of soak testing with mock or dev traffic against Phases 1-4.
**Estimate:** 6-10 days / ~1200 LOC (high variance — scope may shrink based on Phase 4 measurements)

---

## 1. Purpose

Bring the Firecracker backend from functional to production-grade:

- **Sidecar snapshot pool** — pre-warmed microVMs restored from a signed snapshot, mirroring `sidecar-pool.ts` for Docker
- **Full orphan recovery** — DB registry + jailer chroot scan, resilient to platform crashes
- **Image cache with cosign verification** — shared across restarts, content-addressed
- **Observability** — metrics (counter, gauge, histogram), structured audit events, admin API for debug
- **Rate limits + resource caps** — honor `PLATFORM_RUN_LIMITS` at the VM level
- **Graceful shutdown** — no orphan VMs, no in-flight runs lost

**Everything before this phase exists to make this phase possible.** The goal is Tier 4 parity with Tier 3 (Docker) in stability, operability, and latency — without compromising the isolation/compliance gains Firecracker buys.

---

## 2. Open decision (to revisit before starting)

ADR-007 §3 decision #3 picks **sidecar snapshot pool + agent cold boot** for the MVP. Phase 4's measurements may challenge this:

- If agent cold boot measures **> 1.5s p50**, agent snapshot becomes valuable → add a `SnapshotProvisioner` for the agent runtime here (Level 2 of ADR-007).
- If agent cold boot is **< 800ms p50**, keep the MVP model and defer agent snapshots.
- If sidecar snapshot restore is unstable (incompatibility with `runtime-pi/sidecar/`), fall back to sidecar VM pool with cold boot (still a pre-warm, slower restore).

**Action for the implementer:** run the benchmarks documented in §6 on a realistic host before deciding which optimizations ship in Phase 5. Update this spec's §4 scope accordingly.

---

## 3. Success criteria

1. Sidecar snapshot pool pre-warms `FIRECRACKER_VM_POOL_SIZE` sidecar VMs at boot. Acquiring one takes < 150ms p99.
2. On platform crash + restart: all orphan VMs, TAPs, bridges, drives, and jailer chroots are cleaned up within 30s of boot.
3. Running VMs for active in-flight runs are reconciled (not killed) on restart — the run continues to its natural end.
4. Image cache: a given rootfs version is downloaded + verified once per host. Subsequent runs reuse.
5. Cosign verification failures hard-block boot with a clear error.
6. Metrics exported: `firecracker_vm_provision_duration_seconds`, `firecracker_vm_active_count`, `firecracker_tap_count`, `firecracker_subnet_allocations_in_use`, `firecracker_rootfs_verification_duration_seconds`.
7. Admin API: `GET /api/internal/firecracker/state` returns (admin-only) a snapshot of active VMs + pool + allocations for debug.
8. `PLATFORM_RUN_LIMITS` (`timeout_ceiling_seconds`, `max_concurrent_per_org`) enforced at the orchestrator layer before VM creation.
9. Graceful shutdown drains in-flight runs within `FIRECRACKER_SHUTDOWN_TIMEOUT_SECONDS` or kills them cleanly.
10. ≥ 24h soak test on staging with synthetic traffic (100 runs/hour) shows zero resource leaks (FDs, TAPs, drives, subnets).

---

## 4. File tree

```
apps/api/src/services/firecracker/
├── pool/
│   ├── sidecar-snapshot-pool.ts       (NEW, ~250 LOC) — mirrors sidecar-pool.ts, snapshot-based
│   ├── snapshot-capture.ts            (NEW, ~100 LOC) — one-time capture of a pristine sidecar VM for the pool
│   ├── snapshot-restore.ts            (NEW, ~150 LOC) — restore from snapshot, reconfigure per-run
│   └── pool-metrics.ts                (NEW, ~40 LOC)
├── image/
│   ├── rootfs-cache.ts                (NEW, ~120 LOC) — content-addressed local cache
│   ├── rootfs-download.ts             (NEW, ~80 LOC) — OCI pull from GHCR
│   └── cosign-verifier.ts             (NEW, ~80 LOC) — wraps `cosign verify-blob` or uses a Bun-native lib
├── recovery/
│   ├── vm-registry.ts                 (NEW, ~120 LOC) — DB-backed VM registry with liveness check
│   ├── orphan-scanner.ts              (NEW, ~100 LOC) — filesystem sweep of jailer chroots
│   └── reattach.ts                    (NEW, ~80 LOC) — reconnect to VMs of active runs on restart
├── observability/
│   ├── metrics.ts                     (NEW, ~80 LOC) — Prometheus metrics
│   ├── admin-state.ts                 (NEW, ~60 LOC) — /api/internal/firecracker/state handler
│   └── audit-sink.ts                  (NEW, ~60 LOC) — persist vm.* audit events to a new firecracker_audit_events table

apps/api/src/services/firecracker/
├── real-host.ts                       (MODIFY) — wire in pool, cache, recovery
├── vm-provisioner.ts                  (MODIFY) — add SnapshotRestoreProvisioner (for sidecar at minimum, optionally agent)

apps/api/src/services/
├── run-limits.ts                      (MODIFY) — check FIRECRACKER_MAX_CONCURRENT_RUNS + TAP budget pre-creation

apps/api/src/routes/
└── internal.ts                        (MODIFY) — add /firecracker/state endpoint, admin-only

packages/db/src/schema/
└── firecracker.ts                     (MODIFY) — add firecracker_vm_registry + firecracker_audit_events tables

apps/api/src/lib/
└── boot.ts                            (MODIFY) — boot-time recovery sequence

apps/api/test/integration/services/firecracker/
├── pool.test.ts                       (NEW, KVM-gated)
├── orphan-recovery.test.ts            (NEW, KVM-gated)
├── reattach.test.ts                   (NEW, KVM-gated)
├── image-cache.test.ts                (NEW, no KVM required)
└── graceful-shutdown.test.ts          (NEW, KVM-gated)

.github/workflows/
└── firecracker-soak.yml               (NEW) — nightly 30-minute soak test on a KVM runner
```

---

## 5. Sidecar snapshot pool

### 5.1 One-time capture

The platform ships with a **canonical snapshot** captured during the rootfs CI pipeline (Phase 2 workflow extended):

1. Boot a sidecar VM with a "snapshotting" cmdline flag.
2. Sidecar code (aware of the flag) starts its HTTP server, binds the port, **pauses before accepting traffic**.
3. Firecracker API: `PUT /snapshot/create` with `{"snapshot_type": "Full", "snapshot_path": "/tmp/sidecar.snap", "mem_file_path": "/tmp/sidecar.mem"}`.
4. Capture artifact = `(snap file, mem file)`. Sign both with cosign.
5. Publish alongside `sidecar.ext4`.

Alternative: capture on the host at first boot, cache locally. Simpler but non-reproducible across hosts. **Prefer CI capture** for compliance (signed, auditable, identical across hosts).

### 5.2 Pool structure

Mirror `apps/api/src/services/sidecar-pool.ts`:

```ts
interface PooledSidecarVm {
  vmId: string;
  socketPath: string;
  chrootPath: string;
  configSecret: string;
  hostPort: number;  // pre-exposed for the /configure call
}

const pool: PooledSidecarVm[] = [];

async function replenish(): Promise<void> {
  const needed = FIRECRACKER_VM_POOL_SIZE - pool.length;
  if (needed <= 0) return;
  for (const _ of range(needed)) {
    const vm = await restoreSnapshot();
    pool.push(vm);
  }
}

async function acquireSidecarVm(runId, runSubnet, config): Promise<FirecrackerWorkloadHandle> {
  const entry = pool.pop();
  if (!entry) return createFresh(runId, runSubnet, config);

  // Configure via /configure just like Docker today
  await fetch(`http://${host}:${entry.hostPort}/configure`, {
    method: "POST",
    body: JSON.stringify({ runToken, platformApiUrl, ... }),
  });

  // Attach to the per-run bridge
  await attachTap(entry.vmId, bridgeName, sidecarIp);

  scheduleReplenish();
  return toHandle(entry, runId);
}
```

### 5.3 Restore

`restoreSnapshot()`:

1. Generate new `vmId`, create jailer chroot.
2. Copy snap + mem files into chroot.
3. Start Firecracker pointing at the snap — `PUT /snapshot/load`.
4. Attach a pre-allocated TAP on a standby "pool" bridge (similar to `appstrate-sidecar-pool` network in Docker).
5. Wait for the sidecar HTTP server to respond healthy on `/health`.
6. Return the pool entry.

Target latency: **p99 < 150ms from `acquireSidecarVm()` to ready handle**.

### 5.4 Invalidation

Snapshot is version-bound. When `sidecar.ext4` version changes, regenerate the snapshot in CI. The manifest includes both rootfs hash + snap hash — platform detects mismatch at boot and refuses to use a stale snap.

---

## 6. Performance benchmarks (run before deciding scope)

Create `apps/api/scripts/bench-firecracker.ts` that measures:

| Metric                                                   | Target                                                   | Escalation if missed                                                       |
| -------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------- |
| Sidecar snapshot restore → ready                         | p50 < 100ms, p99 < 150ms                                 | If > 300ms, investigate snapshot content — it may carry unnecessary memory |
| Agent cold boot → first LLM call                         | p50 < 1.5s, p99 < 3s                                     | If > 3s, consider Level 2 agent snapshot                                   |
| Workspace drive creation (reflink)                       | < 5ms                                                    | If > 20ms, check FS and mount options                                      |
| Inputs drive creation (10MB files)                       | < 300ms                                                  | If > 1s, review tar2ext4 config                                            |
| Cold boot memory footprint                               | < 200MB RSS (total: platform + Firecracker + init + Bun) | If > 400MB, audit init + kernel size                                       |
| 100 concurrent runs (mixed sidecar restore + agent cold) | 0% error, p99 latency per run < 5s                       | If any errors, revisit FD budget / subnet allocator / bridge contention    |

Record results in `docs/specs/PHASE_5_BENCHMARKS.md` (new file). Use the numbers to finalize Phase 5 scope before coding.

---

## 7. Orphan recovery (full impl)

### 7.1 DB registry

New table:

```ts
export const firecrackerVmRegistry = pgTable("firecracker_vm_registry", {
  vmId: text("vm_id").primaryKey(),
  runId: uuid("run_id"), // null = pool VM
  role: text("role").notNull(),
  chrootPath: text("chroot_path").notNull(),
  socketPath: text("socket_path").notNull(),
  tapName: text("tap_name"),
  bridgeName: text("bridge_name"),
  status: text("status").notNull(), // "starting" | "running" | "stopping" | "stopped"
  createdAt: timestamp("created_at").notNull().defaultNow(),
  lastHeartbeat: timestamp("last_heartbeat"),
});
```

Write on every lifecycle transition. Delete on clean removal.

### 7.2 Boot-time reconciliation

```
reconcileOnBoot():
  // 1. DB → filesystem sweep
  activeRunsVms = SELECT vm_id, run_id, chroot_path FROM firecracker_vm_registry
                  JOIN runs ON runs.id = run_id
                  WHERE runs.status IN ('pending', 'running')

  for vm in activeRunsVms:
    if chroot exists AND API socket responds:
      reattach(vm)  // VM is still alive, continue the run
    else:
      markRunFailed(vm.run_id, reason: "vm crashed during platform outage")
      cleanupVmArtifacts(vm)

  // 2. Filesystem → DB sweep
  allChroots = ls /srv/jailer/firecracker/
  for chroot in allChroots:
    if chroot.vm_id not in firecrackerVmRegistry:
      killVmIfRunning(chroot)
      rm -rf chroot

  // 3. Orphan bridges/TAPs (Phase 3 logic, called here too)
  cleanupNetworkOrphans()
```

### 7.3 Reattach

If a VM survived the platform outage (rare but possible — platform dies, VM keeps running):

1. Verify the jailer chroot exists + API socket responds.
2. Re-establish log streaming via `readHvc1(vmId)` (picks up mid-stream).
3. Update `status` in the registry.
4. Let the existing run continue.

Reattach requires the Firecracker pipe / socket to survive the platform crash. Document limitations in the self-hosting guide.

---

## 8. Image cache

`apps/api/src/services/firecracker/image/rootfs-cache.ts`:

```
ensureRootfs(manifestUrl):
  manifest = fetch(manifestUrl)
  cachePath = /var/lib/appstrate/firecracker/cache/${manifest.sha256}.ext4
  if exists(cachePath) AND sha256(cachePath) == manifest.sha256:
    return cachePath  // hit

  // miss — download + verify
  download(manifest.url, cachePath)
  cosignVerify(cachePath, manifest.signature, FIRECRACKER_COSIGN_KEY)
  if sha256(cachePath) != manifest.sha256:
    throw "integrity mismatch"

  return cachePath
```

LRU eviction when the cache exceeds `FIRECRACKER_CACHE_MAX_GB` (default 20GB). Never evict in-use rootfs (refcount).

Platform boot ensures the configured rootfs version is cached before accepting traffic.

---

## 9. Metrics + admin API

### 9.1 Prometheus metrics

Expose via the existing metrics endpoint (if any — otherwise add `GET /api/internal/metrics`):

- `firecracker_vm_provision_duration_seconds{source="cold|snapshot", role="sidecar|agent"}` — histogram
- `firecracker_vm_active_count{role}` — gauge
- `firecracker_tap_count` — gauge
- `firecracker_subnet_allocations_in_use` — gauge
- `firecracker_sidecar_pool_size` / `_target_size` — gauges
- `firecracker_rootfs_verification_duration_seconds` — histogram
- `firecracker_orphan_cleanup_total{result="success|failure"}` — counter

### 9.2 Admin state endpoint

```
GET /api/internal/firecracker/state
Authorization: admin-only

Response: {
  pool: { target: N, current: M, entries: [{ vmId, age, healthy }] },
  activeRuns: [{ runId, vms: [...], networking: {...} }],
  cache: { entries: [{ sha256, size, lastUsed }], totalBytes },
  subnets: { allocated: N, capacity: M },
  host: { kernel, firecrackerVersion, kvmAvailable, fdBudget },
}
```

Use for debug during incident response.

---

## 10. Rate limits + graceful shutdown

### 10.1 Pre-creation caps

Extend `services/run-limits.ts`:

- Reject if `firecracker_vm_active_count > FIRECRACKER_MAX_CONCURRENT_RUNS * 2` (sidecar + agent per run).
- Reject if `tap_count > FIRECRACKER_MAX_CONCURRENT_RUNS * 2 + pool_size`.
- Reject if host FD margin below threshold.
- Reject if subnet ledger full.

All rejections return 429 with problem+json + `Retry-After`.

### 10.2 Graceful shutdown

`FirecrackerOrchestrator.shutdown()`:

1. Stop accepting new runs (existing `run-tracker.ts` gate).
2. Wait for in-flight runs up to `FIRECRACKER_SHUTDOWN_TIMEOUT_SECONDS` (default 60s).
3. For remaining runs: send `InstanceHalt` via API, mark registry + run records.
4. Drain sidecar pool (destroy all pool VMs).
5. Remove egress bridge + iptables rules.
6. Close all DB connections.

Timeout default of 60s balances shutdown speed with run completion. Document override in self-hosting.

---

## 11. Soak test

`.github/workflows/firecracker-soak.yml`:

- Nightly schedule
- Provision a KVM-enabled GitHub Actions runner (self-hosted or Actions Runner Controller with nested virt)
- Run 30 minutes of synthetic agent traffic at 100 runs/hour
- Collect metrics; fail build if:
  - any VM leaked (active count at end != active count at start)
  - any TAP leaked
  - p99 latency > 5s
  - error rate > 0.5%

Post-soak, upload metrics + logs to an artifact for review.

---

## 12. Env additions

```ts
FIRECRACKER_CACHE_MAX_GB: z.coerce.number().int().min(1).default(20),
FIRECRACKER_SHUTDOWN_TIMEOUT_SECONDS: z.coerce.number().int().min(1).default(60),
FIRECRACKER_HEARTBEAT_INTERVAL_SECONDS: z.coerce.number().int().min(1).default(30),
FIRECRACKER_ORPHAN_SCAN_INTERVAL_SECONDS: z.coerce.number().int().min(60).default(3600),  // hourly
```

---

## 13. Implementation order (suggestion — adapt based on benchmarks)

1. Run the benchmarks from §6 against Phases 1-4. Record results.
2. Decide scope: sidecar snapshot pool always, agent snapshot **only if** cold boot fails targets.
3. `firecracker_vm_registry` + `firecracker_audit_events` tables + migrations.
4. Orphan recovery (registry + scanner + reattach). Ship this **first** — biggest stability win.
5. Image cache + cosign verification. Ship second — compliance blocker.
6. Sidecar snapshot pool — requires CI changes to capture the snapshot alongside the rootfs.
7. Metrics + admin API.
8. Rate limits + graceful shutdown.
9. Soak workflow.
10. Documentation: self-hosting guide for Tier 4, troubleshooting runbook.

---

## 14. Risks

| Risk                                                    | Mitigation                                                                                                                                                    |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Snapshot restore incompatible across kernel versions    | Pin kernel version in snapshot manifest; regenerate on kernel bump                                                                                            |
| Reattach after platform crash leaves inconsistent state | Fail-fast if any registry invariant violated; mark affected runs failed                                                                                       |
| Cache grows unboundedly                                 | LRU eviction + max-size env var                                                                                                                               |
| Soak test flakiness masks real leaks                    | Monitor trend over 7 days, not one-off                                                                                                                        |
| Cosign key compromised                                  | Use keyless signing (Sigstore OIDC) in CI; revoke via manifest rotation                                                                                       |
| Pool snapshot carries sensitive state                   | Capture from a fully-generic sidecar with no real credentials loaded; verify via test that `runToken`, `platformApiUrl` are empty in the snapshot memory dump |
| Nested virt on cloud hosts unstable                     | Document required host types per provider (AWS .metal, GCP nested-virt, Hetzner bare-metal, etc.)                                                             |

---

## 15. Reviewer checklist

- [ ] Benchmarks ran; results in `PHASE_5_BENCHMARKS.md`
- [ ] Sidecar pool acquire p99 < 150ms
- [ ] Orphan recovery sweeps cleanly on forced kill + restart
- [ ] Image cache reuses existing verified rootfs
- [ ] Admin state endpoint works and is admin-only
- [ ] 24h soak shows zero leaks
- [ ] Graceful shutdown completes within timeout
- [ ] Metrics exposed and scrape-able
- [ ] Self-hosting docs updated for Tier 4
- [ ] CHANGELOG + release notes drafted

## 16. References

- [Firecracker snapshot support](https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md)
- [Sigstore keyless signing](https://docs.sigstore.dev/cosign/signing/overview/)
- [AWS Lambda SnapStart paper](https://www.usenix.org/conference/nsdi23/presentation/brooker) — reference pattern for pristine snapshots
- [Phase 4 spec](./PHASE_4_FIRECRACKER_LOGS_AND_FILES.md) — prerequisite
- [ADR-007](../adr/ADR-007-firecracker-orchestrator.md) — architectural decisions, especially §Iterability

---

## 17. After Phase 5

Tier 4 is production-ready. Remaining roadmap items (not scheduled):

- **Agent snapshot pre-loaded** (Level 2 pristine snapshot) if not shipped in Phase 5
- **vsock migration** for sidecar↔agent (listener abstraction posed in Phase 1)
- **Custom `PI_IMAGE`** via `CustomImageProvisioner` plugin path
- **Remote attestation** (vTPM) for contractual compliance
- **Per-agent snapshots** (Level 3) — only with data justifying it
- **K8s/Firecracker hybrid** via the `ContainerOrchestrator` interface (a Kata-style K8s backend would implement the same interface)
