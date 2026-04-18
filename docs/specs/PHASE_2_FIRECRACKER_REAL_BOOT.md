# Phase 2 — Real VM Boot via Firecracker API

> **⚠️ Spec non figée.** Ce document capture l'intention et les décisions prises en Phase 0 (voir [ADR-007](../adr/ADR-007-firecracker-orchestrator.md)). L'agent qui implémente cette phase est **invité à challenger** toute décision qui s'avère inapplicable, sous-optimale, ou rendue obsolète par ce qui a été appris en Phase 1. Les décisions stratégiques de l'ADR restent valides, mais les choix tactiques (structure de fichiers, APIs internes, découpage des tests) sont ajustables. Toute déviation majeure doit être notée dans le PR et synchronisée avec l'ADR.

**Status:** Pending Phase 1 completion
**Prerequisites:** Phase 1 merged. Host with `/dev/kvm` + `CAP_NET_ADMIN` for manual validation. `jailer` + `firecracker` binaries installed.
**Estimate:** 5-7 days / ~1500 LOC + CI workflow
**Phase of:** 5-phase Firecracker rollout (see ADR-007)

---

## 1. Purpose

Replace the `MockFirecrackerHost` with a real implementation that:

- Shells out to `jailer` and `firecracker` binaries for real VM lifecycle
- Boots a real Linux microVM with a signed rootfs produced in CI
- Runs a custom init binary that mounts drives, sets up console redirection, and exec's the payload (`entrypoint.ts` for agent, `server.ts` for sidecar)
- Completes a full agent run end-to-end on a KVM-equipped host with `RUN_ADAPTER=firecracker` + `FIRECRACKER_MOCK_HOST=false`

Networking is deliberately minimal in Phase 2 — just enough for the sidecar to reach the platform and the agent to reach the sidecar. Per-run bridges, static IP allocation, and NAT land in Phase 3.

---

## 2. Success criteria

1. CI workflow `.github/workflows/publish-firecracker-rootfs.yml` builds + signs + publishes `runtime-pi.ext4` + `sidecar.ext4` to GHCR on `v*` tags.
2. Custom init binary (Go, `runtime-pi/init/`) is baked into both rootfs artifacts.
3. `RealFirecrackerHost` implements the full `FirecrackerHost` interface from Phase 1 against real binaries.
4. Contract tests from Phase 1 pass identically against `RealFirecrackerHost` on a KVM-equipped runner.
5. On a dev machine with KVM: `RUN_ADAPTER=firecracker FIRECRACKER_MOCK_HOST=false bun run dev` + a sample agent run produces the same output stream as Tier 3 (Docker).
6. Exit codes from the agent propagate correctly to the platform.
7. Kernel boot log never leaks into the app stdout stream (separated consoles work).
8. CI rootfs artifacts are content-addressed (SHA256 in filename) and cosign-signed.

---

## 3. File tree

```
.github/workflows/
└── publish-firecracker-rootfs.yml     (NEW) — CI builds + signs rootfs on tag

runtime-pi/
├── Dockerfile                         (MODIFY) — add init binary to /sbin/init
├── init/                              (NEW DIR)
│   ├── go.mod                         (NEW)
│   ├── init.go                        (NEW, ~80 LOC) — the custom init binary
│   └── README.md                      (NEW) — boot protocol documentation

runtime-pi/sidecar/
├── Dockerfile                         (MODIFY) — add init binary to /sbin/init
└── (no other changes)

scripts/
└── build-firecracker-rootfs.sh        (NEW, ~60 LOC) — local build helper (mirrors CI steps)

apps/api/src/services/firecracker/
├── real-host.ts                       (NEW, ~500 LOC) — RealFirecrackerHost
├── firecracker-api.ts                 (NEW, ~200 LOC) — HTTP client for the Firecracker API socket
├── jailer.ts                          (MODIFY — real impl) — jailer command builder + process launcher
├── rootfs-resolver.ts                 (NEW, ~80 LOC) — reads FIRECRACKER_ROOTFS_PATH or downloads from GHCR + verifies cosign signature
└── process-supervisor.ts              (NEW, ~100 LOC) — spawn + track jailer child processes, clean up on platform shutdown

apps/api/src/services/orchestrator/
└── firecracker-orchestrator.ts        (MODIFY) — replace `realHostOrThrow()` with real instantiation

packages/env/src/
└── index.ts                           (MODIFY) — add FIRECRACKER_ROOTFS_URL, FIRECRACKER_COSIGN_KEY

apps/api/test/integration/services/
└── firecracker-real-boot.test.ts      (NEW, gated on CI runner labels) — end-to-end real boot test
```

---

## 4. Custom init binary (`runtime-pi/init/init.go`)

The init binary is PID 1 inside every Firecracker VM. It is deliberately minimal — ~80 LOC of Go, statically compiled.

**Responsibilities (in order):**

1. Mount `/proc`, `/sys`, `/dev/pts`, `/tmp` (tmpfs) using syscall `Mount`.
2. Detect role from `/proc/cmdline` (kernel cmdline contains `appstrate.role=agent` or `appstrate.role=sidecar`).
3. **Agent only:** mount `/inputs` (read-only) from `/dev/vdb` and `/workspace` (read-write) from `/dev/vdc`.
4. **Sidecar only:** no drives beyond rootfs.
5. Redirect stdout to `/dev/hvc1` (the app-log virtio-console). Leave stderr on `/dev/console` (→ `ttyS0`, kernel + debug).
6. Parse env vars from `/proc/cmdline` (format: `appstrate.env.KEY=VALUE` — URL-decoded). Copy them into the payload's environment.
7. `exec` the payload:
   - Agent: `/usr/local/bin/bun run /runtime/entrypoint.ts`
   - Sidecar: `/usr/local/bin/bun run /runtime/sidecar-server.ts`
8. On payload exit, write the exit code to `/dev/vdd` (a 16-byte side-channel block device — see §6) then `reboot()` syscall.

**Why Go:** single static binary, no libc, fits in ~2MB, boots fast. Alternatives (shell script, Rust) are acceptable if they meet the same contract. **Document the choice in the PR description** if you deviate.

**Security:** init must `setuid(0)` then immediately drop any ambient capabilities it doesn't need. The payload itself runs as a dedicated non-root user baked into the rootfs (`pi:pi`, uid 1000) — init switches user before exec.

---

## 5. Firecracker API client

`apps/api/src/services/firecracker/firecracker-api.ts` wraps the HTTP-over-unix-socket API exposed by the Firecracker process. The pattern follows `apps/api/src/services/docker.ts`: raw `fetch()` via unix socket, no dockerode-equivalent dependency.

Required RPCs:

| Method  | Path                       | Purpose                                                                                        |
| ------- | -------------------------- | ---------------------------------------------------------------------------------------------- |
| `PUT`   | `/boot-source`             | Set kernel + cmdline                                                                           |
| `PUT`   | `/drives/rootfs`           | Attach rootfs.ext4 (read-only)                                                                 |
| `PUT`   | `/drives/inputs`           | Attach inputs drive (agent only, read-only)                                                    |
| `PUT`   | `/drives/workspace`        | Attach workspace drive (agent only, read-write)                                                |
| `PUT`   | `/drives/exit-code`        | Attach 16-byte block device for exit-code side channel                                         |
| `PUT`   | `/network-interfaces/eth0` | Attach TAP (actual TAP lifecycle in Phase 3; Phase 2 uses a trivial loopback or static config) |
| `PUT`   | `/vsock`                   | (deferred to post-MVP)                                                                         |
| `PUT`   | `/machine-config`          | Set memory + vCPUs                                                                             |
| `PUT`   | `/actions`                 | `{"action_type": "InstanceStart"}`                                                             |
| `PATCH` | `/machine-config`          | For snapshot restore (Phase 5)                                                                 |

Include a retry loop with exponential backoff when the API socket isn't yet available (Firecracker takes ~10ms to create it after process start).

---

## 6. Exit-code side-channel

Firecracker doesn't expose a clean "VM exited with code N" primitive — the init binary must write it somewhere the platform can read.

**Mechanism:** attach a 16-byte sparse file as `/dev/vdd`. The init writes the exit code as a fixed-format string (`exit=%d\n`) to this block device before calling `reboot()`. The platform reads the file after VM shutdown.

**`waitForExit(vmId)` implementation:**

1. Poll the Firecracker API `/` endpoint for `state: "Stopped"` (with 500ms interval + AbortSignal).
2. On stop, read the exit-code file from the jailer chroot.
3. Parse `exit=N\n` → return N.
4. On parse failure or missing file → return -1 (signals abnormal termination).

---

## 7. Rootfs pipeline (CI)

`.github/workflows/publish-firecracker-rootfs.yml`:

**Trigger:** `push: tags: ['v*']` (same cadence as main Docker image).

**Steps per rootfs (agent + sidecar, two parallel matrix jobs):**

1. Checkout repo, install Go, build `runtime-pi/init/init.go` as a static binary.
2. `docker buildx build --platform linux/amd64 --output type=local,dest=./layers -f runtime-pi/Dockerfile .`
3. Copy the init binary into `./layers/sbin/init`.
4. `tar -cf rootfs.tar -C ./layers .`
5. Run `tar2ext4 -i rootfs.tar -o runtime-pi-<version>.ext4` (use the Microsoft hcsshim binary or build from source — see references).
6. `cosign sign-blob --key ${COSIGN_KEY} --output-signature rootfs.sig runtime-pi-<version>.ext4`
7. `sha256sum runtime-pi-<version>.ext4 > rootfs.sha256`
8. Upload to GHCR as an OCI artifact with media type `application/vnd.appstrate.rootfs.ext4`.
9. Publish a JSON manifest at `runtime-pi-<version>.manifest.json` containing: version, commit sha, rootfs sha256, signature path, kernel version expected, init binary sha256.

**Kernel:** Phase 2 uses the upstream Firecracker recommended vmlinux (pinned SHA256). The kernel build is separate from the rootfs pipeline — checked in as a build input in `runtime-pi/kernel/vmlinux.sha256`. Document the kernel sourcing in the PR.

**Local build:** `scripts/build-firecracker-rootfs.sh` mirrors the CI steps for dev machines. No signing in local mode.

---

## 8. Host-side download + verify (`rootfs-resolver.ts`)

On boot (inside `FirecrackerOrchestrator.initialize()`):

1. If `FIRECRACKER_ROOTFS_PATH` points to an existing local file, use it as-is (dev convenience).
2. Otherwise, download from `FIRECRACKER_ROOTFS_URL` (GHCR OCI artifact).
3. Verify cosign signature against `FIRECRACKER_COSIGN_KEY` (public key, path or raw PEM).
4. Verify sha256 matches the manifest.
5. Cache at `/var/lib/appstrate/firecracker/<sha256>.ext4`.
6. Log the resolved version for audit.

Reject boot if verification fails. No fallback, no degraded mode.

---

## 9. Env var additions

```ts
FIRECRACKER_ROOTFS_URL: z.string().optional(),
FIRECRACKER_SIDECAR_ROOTFS_URL: z.string().optional(),
FIRECRACKER_COSIGN_KEY: z.string().optional(),
FIRECRACKER_KERNEL_URL: z.string().optional(),
FIRECRACKER_SKIP_SIGNATURE_VERIFICATION: z
  .string()
  .default("false")
  .transform((v) => v === "true" || v === "1"),
```

Add a refine: if `NODE_ENV=production` and `RUN_ADAPTER=firecracker` and `FIRECRACKER_MOCK_HOST=false`, then `FIRECRACKER_COSIGN_KEY` must be set AND `FIRECRACKER_SKIP_SIGNATURE_VERIFICATION` must be `false`. Dev can skip.

---

## 10. Tests

### 10.1 Unit tests

- `firecracker-api.test.ts` — mock the unix socket `fetch`, verify each RPC produces the expected JSON body.
- `jailer.test.ts` — command-builder snapshot tests (given a config, verify the argv + env).
- `rootfs-resolver.test.ts` — verify sha mismatch throws, missing signature throws, cached file is reused.
- `init/init_test.go` — unit tests for cmdline parsing, env extraction.

### 10.2 Integration tests (gated)

`firecracker-real-boot.test.ts` runs only on self-hosted runners labeled `kvm-enabled`. Skipped elsewhere with `test.skipIf(!hasKvm())`.

Test cases:

- Boot a sidecar VM → it responds `200` on `/health` via the host-mapped port (Phase 2 uses port-forward, Phase 3 uses TAP).
- Boot an agent VM with inputs drive → it reads the inputs, runs `entrypoint.ts`, exits cleanly.
- Agent exit code `1` is captured and returned by `waitForExit()`.
- Kernel boot log is visible on `streamDebugLogs(vmId)` but absent from `streamLogs(vmId)` (which reads hvc1).
- Shutdown is clean: jailer chroot removed, no FD leaks.

### 10.3 Contract conformity

The Phase 1 integration tests (`firecracker-orchestrator.test.ts`) must pass identically with `host = new RealFirecrackerHost()` on KVM-enabled runners. If they don't, the mock in Phase 1 was wrong — **fix the mock**, don't diverge the tests.

---

## 11. Implementation order

1. Write `init/init.go` + tests, build as static binary. Verify it boots in a standalone Firecracker VM manually.
2. Modify `runtime-pi/Dockerfile` (+ sidecar Dockerfile) to bake in the init.
3. Write `scripts/build-firecracker-rootfs.sh` and produce a local `runtime-pi.ext4`. Boot it manually via raw `firecracker` CLI to validate.
4. Write `firecracker-api.ts` + unit tests.
5. Write `jailer.ts` (real impl) + unit tests.
6. Write `rootfs-resolver.ts` + unit tests.
7. Write `process-supervisor.ts` — child process tracking, cleanup on parent shutdown.
8. Write `real-host.ts` — glue layer implementing `FirecrackerHost`.
9. Wire into `FirecrackerOrchestrator` via `realHostOrThrow()` → `new RealFirecrackerHost()`.
10. Write the CI workflow. Tag a test release, verify artifacts on GHCR, verify cosign signature.
11. Run Phase 1 integration suite against `RealFirecrackerHost` on a KVM runner. Fix any divergence.
12. Write `firecracker-real-boot.test.ts` end-to-end.
13. Update `.env.example` + `CHANGELOG.md`.

---

## 12. Non-goals (explicitly deferred)

- Per-run bridges, TAP allocation, NAT, DNS → Phase 3
- `/dev/hvc1` log streaming implementation (Phase 2 uses stderr for everything, acceptable for first boot) → Phase 4
- Inputs drive mounting + hashing → Phase 4 (Phase 2 passes `/inputs` empty)
- Workspace drive reflink template → Phase 4 (Phase 2 uses plain mkfs)
- Sidecar snapshot pool → Phase 5
- Orphan recovery with DB reconciliation → Phase 5
- vsock, MMDS, custom CPU templates → post-MVP

---

## 13. Risks

| Risk                                            | Mitigation                                                                                    |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Init binary bugs cause boot loops               | Boot tests on a local QEMU-KVM first, never land an untested init in the rootfs               |
| Firecracker API contract drift between versions | Pin Firecracker binary version in env (`FIRECRACKER_VERSION_CHECK`) and fail-fast on mismatch |
| Jailer chroot leaks accumulate                  | Phase 5 adds real cleanup; Phase 2 operators must manually prune on restart                   |
| CI cosign key handling                          | Use GitHub OIDC + Sigstore keyless signing to avoid managing a long-lived key                 |
| Kernel CVEs require rebuild                     | Kernel pinned in manifest; subscribe to `kernel-cve@` list + document rebuild SLA             |

---

## 14. Reviewer checklist

- [ ] CI workflow produces signed artifacts on a test tag
- [ ] Init binary is reproducibly built (same input → same sha256)
- [ ] `RealFirecrackerHost` passes the Phase 1 contract suite
- [ ] Sample agent run completes on a KVM-equipped dev machine
- [ ] Exit codes propagate correctly for both success and failure
- [ ] No Phase 3/4/5 scope creep in the PR

## 15. References

- [Firecracker API spec](https://github.com/firecracker-microvm/firecracker/blob/main/src/api_server/swagger/firecracker.yaml)
- [Firecracker jailer](https://github.com/firecracker-microvm/firecracker/blob/main/docs/jailer.md)
- [tar2ext4 (Microsoft hcsshim)](https://github.com/microsoft/hcsshim/tree/main/ext4/tar2ext4)
- [Sigstore cosign keyless signing](https://docs.sigstore.dev/cosign/signing/signing_with_blobs/)
- [Phase 1 spec](./PHASE_1_FIRECRACKER_SKELETON.md) — prerequisite
- [ADR-007](../adr/ADR-007-firecracker-orchestrator.md) — architectural decisions
