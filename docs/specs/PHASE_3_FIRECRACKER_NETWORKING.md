# Phase 3 — Production Networking (TAP + Bridges + Isolation)

> **⚠️ Spec non figée.** Ce document capture l'intention et les décisions prises en Phase 0 (voir [ADR-007](../adr/ADR-007-firecracker-orchestrator.md)). L'agent qui implémente cette phase est **invité à challenger** toute décision qui s'avère inapplicable, sous-optimale, ou rendue obsolète par ce qui a été appris en Phases 1-2. Les décisions stratégiques de l'ADR restent valides, mais les choix tactiques (allocation de sous-réseaux, format TAP, wiring netlink) sont ajustables. Toute déviation majeure doit être notée dans le PR et synchronisée avec l'ADR.

**Status:** Pending Phase 2 completion
**Prerequisites:** Phase 2 merged. Real VMs booting. KVM host with `CAP_NET_ADMIN` for dev validation.
**Estimate:** 4-6 days / ~800 LOC

---

## 1. Purpose

Replace the Phase 2 "trivial loopback or static config" networking with the full ADR-007 model:

- **One Linux bridge per run** (`fc-br-{runId8}`), internal (no NAT), agent lives here
- **One global egress bridge** with NAT masquerade, sidecar has a second TAP here
- **Per-run `/30` subnet allocation** with DB-backed ledger (no collision, survives restarts)
- **`/etc/hosts` injection** so the agent's `fetch("http://sidecar:8080/proxy")` resolves unchanged
- **TAP lifecycle** tied to jailer netns: created before VM start, torn down on VM stop
- **FD-budget enforcement** — reject new runs when the host's TAP budget is exhausted

This phase delivers the isolation guarantee that matches Docker's dual-network pattern (ADR-003 compatible).

---

## 2. Success criteria

1. Agent VM on a per-run internal bridge has **no route to the host** (verified by `traceroute 8.8.8.8` failing from inside the agent).
2. Sidecar VM reaches the platform API + LLM providers via the egress bridge (verified by `curl` to platform succeeding).
3. Agent resolves `sidecar` to the correct static IP via `/etc/hosts` and can `curl http://sidecar:8080/health` successfully.
4. 50 concurrent runs on the same host create 50 distinct bridges + 100 TAPs with zero collisions.
5. On platform crash + restart, orphaned TAPs + bridges are reclaimed via the cleanup path (Phase 5 completes the full reconciliation, Phase 3 handles the netlink side).
6. Subnet ledger persists in DB and recovers after restart (allocations re-enter the pool if their run is terminal).
7. A run attempting to start when the TAP budget is exhausted fails fast with a clear RFC 9457 error.

---

## 3. File tree

```
apps/api/src/services/firecracker/
├── network/
│   ├── bridge-manager.ts              (NEW, ~120 LOC) — create/delete Linux bridges via netlink (rtnetlink bindings or ip(8) shell-out)
│   ├── tap-manager.ts                 (MODIFY — real impl) — create TAP, attach to bridge, attach to VM netns
│   ├── nat-manager.ts                 (NEW, ~80 LOC) — iptables/nftables rules for the egress bridge
│   ├── subnet-allocator.ts            (NEW, ~100 LOC) — DB-backed /30 allocator with LISTEN/NOTIFY for cross-instance coordination
│   ├── hosts-file.ts                  (NEW, ~40 LOC) — build an /etc/hosts fragment, write to inputs drive or via kernel cmdline
│   └── fd-budget.ts                   (NEW, ~60 LOC) — check /proc/sys/fs/file-max + current open FDs, enforce TAP budget

apps/api/src/services/firecracker/
├── real-host.ts                       (MODIFY) — wire in the real network managers, replace Phase 2 stubs

packages/db/src/schema/
└── firecracker.ts                     (NEW) — Drizzle schema for firecracker_subnet_allocations

packages/db/
└── drizzle/migrations/                (NEW migration) — create firecracker_subnet_allocations table

apps/api/src/lib/
└── boot.ts                            (MODIFY) — reclaim abandoned subnet allocations on startup

apps/api/test/integration/services/firecracker/
├── bridge-manager.test.ts             (NEW, KVM-gated)
├── subnet-allocator.test.ts           (NEW, DB-backed, no KVM required)
├── tap-manager.test.ts                (NEW, KVM-gated)
└── networking-e2e.test.ts             (NEW, KVM-gated) — end-to-end connectivity checks
```

---

## 4. Subnet allocation

A naive hash allocator (Phase 1) collides at ~50 concurrent runs. Phase 3 replaces it with a DB-backed ledger.

### 4.1 Schema

```ts
// packages/db/src/schema/firecracker.ts
import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

export const firecrackerSubnetAllocations = pgTable(
  "firecracker_subnet_allocations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull(),
    subnet: text("subnet").notNull(), // e.g. "10.200.42.0/30"
    bridgeName: text("bridge_name").notNull(),
    allocatedAt: timestamp("allocated_at").notNull().defaultNow(),
    releasedAt: timestamp("released_at"),
  },
  (t) => ({
    uniqueActiveSubnet: uniqueIndex("uq_active_subnet")
      .on(t.subnet)
      .where(sql`released_at IS NULL`),
    runIdIdx: index("idx_subnet_run").on(t.runId),
  }),
);
```

The partial-unique index makes the allocation atomic: two concurrent inserts with the same subnet fail cleanly, and the allocator retries with the next free slot.

### 4.2 Algorithm

```
allocate(runId):
  for attempt in 0..MAX_ATTEMPTS:
    subnet = next_candidate(FIRECRACKER_BRIDGE_SUBNET)  // walks the /16 in /30 steps
    try:
      INSERT INTO firecracker_subnet_allocations (run_id, subnet, bridge_name) VALUES (...)
      return subnet
    except UniqueViolation:
      continue
  throw CapacityExhausted

release(runId):
  UPDATE firecracker_subnet_allocations SET released_at = NOW() WHERE run_id = $1 AND released_at IS NULL
```

On boot: `reclaimAbandonedAllocations()` marks all allocations whose `runId` references a terminal run (status in `success|failed|timeout|cancelled`) as released.

### 4.3 /30 math

Each run gets a `/30` inside the platform-wide bridge subnet (default `10.200.0.0/16`). A `/30` = 4 IPs:

| Offset | Purpose                    |
| ------ | -------------------------- |
| .0     | Network                    |
| .1     | Gateway (bridge host-side) |
| .2     | Sidecar                    |
| .3     | Agent                      |

`/16` provides 16384 simultaneous runs — plenty even for Enterprise density.

---

## 5. Bridge + TAP lifecycle

### 5.1 Bridge creation (per run)

```
createBridge(name, subnet):
  ip link add name ${name} type bridge
  ip addr add ${gateway_ip}/30 dev ${name}
  ip link set ${name} up
```

Bridge is `internal` for the agent-facing side — no default route, no NAT. This is a kernel-level firewall guarantee, not an iptables rule.

### 5.2 Egress bridge (global, created at boot)

```
createEgressBridge():
  ip link add name ${FIRECRACKER_EGRESS_BRIDGE} type bridge  // e.g. "fc-egress"
  ip addr add ${egress_gateway}/24 dev ${FIRECRACKER_EGRESS_BRIDGE}
  ip link set ${FIRECRACKER_EGRESS_BRIDGE} up
  # NAT masquerade for outbound
  iptables -t nat -A POSTROUTING -s ${egress_subnet} -o ${host_external_if} -j MASQUERADE
  iptables -A FORWARD -i ${FIRECRACKER_EGRESS_BRIDGE} -o ${host_external_if} -j ACCEPT
  iptables -A FORWARD -i ${host_external_if} -o ${FIRECRACKER_EGRESS_BRIDGE} -m state --state RELATED,ESTABLISHED -j ACCEPT
```

Sidecar's second TAP attaches here. Agent never attaches here.

**Preferred library:** use `ip` / `iptables` binaries via shell-out for Phase 3 (matches what the `docker.ts` service does). Proper netlink bindings (rtnetlink crate or nl library) are a post-MVP optimization — shell-out is simpler, debuggable, and fast enough (~5-10ms per operation).

### 5.3 TAP attachment

```
createTap(vmId, bridgeName, vmIp):
  tap_name = "fc-tap-${vmId[:8]}"          // 15-char limit
  ip tuntap add mode tap name ${tap_name}
  ip link set ${tap_name} master ${bridgeName}
  ip link set ${tap_name} up
  return tap_name
```

TAP is then passed to Firecracker via `PUT /network-interfaces/eth0` with the host-dev = tap_name + guest MAC.

**Cleanup:** on VM stop, `ip link delete ${tap_name}`. Idempotent. On platform crash, orphan sweep (see §7).

### 5.4 TAP name collision

`fc-tap-{8 chars of vmId}` — UUIDv4 collision at 8 chars is 1 in ~4B. If you ever see one in prod, you have bigger problems. Still, the `ip tuntap add` will fail EEXIST and the caller must retry with a fresh `vmId` + audit the event.

---

## 6. `/etc/hosts` injection for the agent

The agent's env has `SIDECAR_URL=http://sidecar:8080` (set by `FirecrackerOrchestrator.createWorkload`). The VM must resolve `sidecar` to the correct `.2` IP of its per-run subnet.

**Mechanism:** the inputs drive (Phase 4) includes a file `/etc/hosts.appstrate` with `${sidecar_ip}  sidecar`. The init binary (Phase 2) cat's this file into `/etc/hosts` before exec'ing the payload.

Alternative considered: MMDS-over-http with a boot-time hook. Rejected as overkill — `/etc/hosts` is simpler and works identically in Docker.

**Ship order:** Phase 3 prepares the IP + writes the hosts fragment. Phase 4 implements the inputs drive + init logic to consume it. Phase 3 can test by poking the file directly into the agent's rootfs overlay for its own tests.

---

## 7. TAP orphan cleanup

Phase 5 owns the full VM orphan reconciliation. Phase 3 owns the network-layer sweep:

```
cleanupNetworkOrphans():
  // List all TAPs matching our naming pattern
  for tap in `ip -j link show` where name ~= /^fc-tap-[0-9a-f]{8}$/:
    if tap.vmId not in active DB runs:
      ip link delete ${tap.name}

  // List all bridges matching our naming pattern
  for bridge in `ip -j link show type bridge` where name ~= /^fc-br-[0-9a-f]{8}$/:
    if bridge.runId not in active DB runs:
      ip link delete ${bridge.name}
```

Called from `FirecrackerOrchestrator.cleanupOrphans()` alongside the VM sweep.

---

## 8. FD budget enforcement

Each run consumes:

- 2 TAP devices (one per VM, each TAP = 1 FD on the host)
- 2 Firecracker processes (each ~10-20 FDs for sockets, drives, API)
- 1 bridge (1 FD)

Rough upper bound: ~50 FDs per run. At 50 concurrent runs = 2500 FDs. Default `fs.file-max` is typically 1M+ — safe. But default `ulimit -n` on the Appstrate process is often 1024 — **we must raise it at boot**.

```
checkFdBudget():
  current = count of FDs open by the platform process
  limit = getrlimit(RLIMIT_NOFILE).soft
  if limit - current < FD_SAFETY_MARGIN (default 500):
    reject new run with ERROR_FD_EXHAUSTED
```

Log a warning at boot if `limit < 65536`. Consider auto-raising via `setrlimit(RLIMIT_NOFILE)` at startup if running as root (post-jailer drop).

---

## 9. Env additions

```ts
FIRECRACKER_EGRESS_BRIDGE: z.string().default("fc-egress"),
FIRECRACKER_EGRESS_SUBNET: z.string().default("10.201.0.0/24"),
FIRECRACKER_HOST_EXTERNAL_IF: z.string().default("eth0"),  // masquerade out-interface
FIRECRACKER_FD_SAFETY_MARGIN: z.coerce.number().int().min(0).default(500),
FIRECRACKER_MAX_CONCURRENT_RUNS: z.coerce.number().int().min(1).default(50),  // soft cap, refuse beyond
```

---

## 10. Tests

### 10.1 DB-only (no KVM)

- `subnet-allocator.test.ts`:
  - Allocates unique subnets for N concurrent inserts.
  - Retries on UniqueViolation.
  - `release()` marks released, subsequent allocation can reuse.
  - `reclaimAbandoned()` frees allocations tied to terminal runs.
  - Throws `CapacityExhausted` when `/16` is full (use a tiny subnet for this test).

### 10.2 KVM-gated

- `bridge-manager.test.ts`: create, query via `ip link show`, delete. Idempotent.
- `tap-manager.test.ts`: create TAP, verify it appears in the bridge, delete, verify removed.
- `networking-e2e.test.ts`:
  - Start a sidecar VM + agent VM pair.
  - From agent: `curl http://sidecar:8080/health` succeeds.
  - From agent: `curl http://8.8.8.8` fails (timeout, no route).
  - From sidecar: `curl https://api.anthropic.com` succeeds (through NAT).
  - Stop the run, verify both TAPs + the bridge are gone.

### 10.3 Failure paths

- Allocator exhausted → run creation returns a clean error (HTTP 503 with problem+json).
- FD budget exhausted → same.
- `ip link delete` fails during cleanup → logged, does not block other cleanups.

---

## 11. Implementation order

1. `firecracker_subnet_allocations` migration + Drizzle schema.
2. `subnet-allocator.ts` + tests (no KVM required).
3. Boot integration: `reclaimAbandonedAllocations()` called from `FirecrackerOrchestrator.initialize()`.
4. `bridge-manager.ts` + `tap-manager.ts` + `nat-manager.ts`.
5. Wire into `RealFirecrackerHost` replacing the Phase 2 stubs.
6. `fd-budget.ts` + integration with run-creation pipeline.
7. KVM-gated integration tests.
8. Update `.env.example` + `CHANGELOG.md`.

---

## 12. Risks

| Risk                                                  | Mitigation                                                                                                                       |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| iptables rules conflict with user's firewall          | Use a dedicated chain (`FIRECRACKER_FORWARD`, `FIRECRACKER_POSTROUTING`) + document in self-hosting guide                        |
| TAP leak under crash pressure                         | Orphan sweep runs both at boot + hourly via a scheduler job                                                                      |
| Subnet exhaustion at scale                            | Default `/16` holds 16384 concurrent runs. Alert at 75% utilization. Document how to widen to `/12` for larger deployments       |
| `ip` binary version differences (iproute2 variants)   | Pin expected version in health check, fail-fast with clear error                                                                 |
| Concurrent boot of platform replicas fight for bridge | Egress bridge creation is idempotent (check-then-create), guarded by a Postgres advisory lock (`pg_advisory_lock(4200)` on boot) |

---

## 13. Reviewer checklist

- [ ] Agent VM cannot reach 8.8.8.8 or the host (hard isolation verified)
- [ ] Sidecar VM can reach the platform + LLM APIs (egress verified)
- [ ] `/etc/hosts` resolves `sidecar` correctly in the agent
- [ ] 50 concurrent runs work without collision or FD exhaustion
- [ ] Orphan sweep removes abandoned TAPs + bridges at boot
- [ ] Subnet allocator is atomic under concurrent load (stress-tested)
- [ ] No iptables rules leak into the host's default tables

## 14. References

- [Firecracker network setup](https://github.com/firecracker-microvm/firecracker/blob/main/docs/network-setup.md)
- [iproute2 man pages](https://man7.org/linux/man-pages/man8/ip.8.html)
- [ADR-003](../adr/ADR-003-sidecar-credential-isolation.md) — dual-network pattern being replicated
- [Phase 2 spec](./PHASE_2_FIRECRACKER_REAL_BOOT.md) — prerequisite
