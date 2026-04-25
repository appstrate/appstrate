# Phase 4 — Log Plumbing, File Injection, Drive Lifecycle

> **⚠️ Spec non figée.** Ce document capture l'intention et les décisions prises en Phase 0 (voir [ADR-007](../adr/ADR-007-firecracker-orchestrator.md)). L'agent qui implémente cette phase est **invité à challenger** toute décision qui s'avère inapplicable, sous-optimale, ou rendue obsolète par ce qui a été appris en Phases 1-3. Les décisions stratégiques de l'ADR restent valides, mais les choix tactiques (format des drives, protocole de stream, détails de l'init) sont ajustables. Toute déviation majeure doit être notée dans le PR et synchronisée avec l'ADR.

**Status:** Pending Phase 3 completion
**Prerequisites:** Phase 3 merged. Real networking functional. VMs reachable from the platform.
**Estimate:** 4-5 days / ~900 LOC

---

## 1. Purpose

Deliver the full runtime contract for a Firecracker-hosted agent run:

- **Clean app log stream** via `/dev/hvc1` (second virtio-console), isolated from kernel + init noise on `ttyS0`
- **`/inputs` drive** — read-only ext4 containing AFPS package + user uploads + `/etc/hosts.appstrate`, mounted by init
- **`/workspace` drive** — ext4 reflink-cloned from a template at VM create time, writable, mounted at `/workspace` in the agent VM
- **Exit-code side-channel** wired end-to-end (init → side-channel block device → platform)
- **Drive hashing** for audit trail: every inputs drive produces a sha256 stored in the run record

After Phase 4, a Firecracker-hosted run is behaviorally indistinguishable from a Docker-hosted run from the platform's perspective — same stdout stream, same exit code, same file injection semantics.

---

## 2. Success criteria

1. Platform-side parser of `/dev/hvc1` produces identical JSON-line output to what Docker's `streamLogs()` produces today for the same agent run.
2. Kernel boot messages never leak into the app log stream.
3. `/inputs` drive is mounted read-only inside the agent VM; writes to it fail.
4. `/workspace` drive is mounted read-write; writes persist during the run; drive file is deleted after run completion.
5. Workspace drive creation takes <20ms on XFS/btrfs hosts (reflink path) and <100ms on ext4/other hosts (full copy fallback).
6. Exit code from the agent's `process.exit(N)` is reported accurately by `waitForExit()`.
7. Inputs drive sha256 is persisted in a new `runs.inputs_drive_sha256` column.
8. A run with zero inputs still boots cleanly (empty `/inputs`).

---

## 3. File tree

```
runtime-pi/init/
├── init.go                            (MODIFY) — add /dev/hvc1 redirect, drive mounts, /etc/hosts merge, exit-code side-channel write

apps/api/src/services/firecracker/
├── drives/
│   ├── workspace-drive.ts             (NEW, ~120 LOC) — create + reflink template + cleanup
│   ├── inputs-drive.ts                (NEW, ~150 LOC) — build ext4 with tar2ext4 from in-memory files + sha256
│   ├── template-builder.ts            (NEW, ~50 LOC) — create the workspace template ext4 once at boot
│   └── reflink.ts                     (NEW, ~40 LOC) — detect FS support (ioctl FICLONE), fall back to copy
├── logs/
│   ├── hvc1-reader.ts                 (NEW, ~100 LOC) — read /dev/pts/N side of the virtio-console, yield lines
│   ├── debug-console-reader.ts        (NEW, ~40 LOC) — read ttyS0 for debug, exposed via admin API only
│   └── line-buffer.ts                 (NEW, ~50 LOC) — assemble partial reads into complete lines
├── real-host.ts                       (MODIFY) — wire in drive managers + log readers; remove Phase 2 stubs

packages/db/src/schema/runs.ts
└── (MODIFY) — add inputs_drive_sha256 column

packages/db/drizzle/migrations/
└── (NEW migration) — add runs.inputs_drive_sha256

apps/api/src/services/firecracker/
├── host.ts                            (MODIFY) — refine createInputsDrive signature to return { path, sha256 }

apps/api/test/unit/services/firecracker/
├── line-buffer.test.ts                (NEW)
├── reflink.test.ts                    (NEW, skipped if FS doesn't support FICLONE)
└── inputs-drive-builder.test.ts       (NEW) — in-memory build + hash validation

apps/api/test/integration/services/firecracker/
├── drive-lifecycle.test.ts            (NEW, KVM-gated or tmpfs-gated) — create + mount (loopback) + verify content
├── log-streaming.test.ts              (NEW, KVM-gated) — boot VM that writes to hvc1, verify platform reads lines
└── exit-code.test.ts                  (NEW, KVM-gated) — agent exits with N, waitForExit returns N
```

---

## 4. `/dev/hvc1` log streaming

### 4.1 VM-side setup (init binary)

The init binary (from Phase 2) now:

1. Opens `/dev/hvc1` write-only.
2. `dup2(fd, 1)` — redirect stdout of the payload.
3. Leaves `stderr` attached to `/dev/console` (ttyS0) — kernel + init debug go there.

The payload (`entrypoint.ts` for agent, `server.ts` for sidecar) writes JSON lines via `console.log` → goes to `/dev/hvc1`. **Zero change to `runtime-pi/entrypoint.ts`.**

### 4.2 Host-side setup

Firecracker API `PUT /vsock` → no, we use virtio-console:

```json
{
  "type": "Virtio",
  "console": "Pipe", // or "Socket", see Firecracker config
  "output": "<path-to-host-side-fd-or-socket>"
}
```

Firecracker 1.4+ supports multiple virtio-console devices via `PUT /virtio-console/N`. For Phase 4, use the unix-pipe backend: Firecracker creates a pipe pair at boot, the host reads from one end while the VM writes to the other.

**Alternative if virtio-console is unstable:** use a serial device (`ttyS1`) instead of virtio-console. Firecracker has better long-term support for serial. Document the choice.

### 4.3 Reader implementation

`hvc1-reader.ts`:

```ts
export async function* readHvc1(vmId: string, signal?: AbortSignal): AsyncGenerator<string> {
  const pipePath = hvc1PipePath(vmId); // resolved from jailer chroot
  const stream = Bun.file(pipePath).stream();
  const reader = stream.getReader();
  const buffer = new LineBuffer();

  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) return;
      buffer.push(value);
      yield* buffer.drainLines();
    }
  } finally {
    reader.releaseLock();
  }
}
```

`line-buffer.ts` handles partial-read reassembly (a single write from the VM may be split across two reads on the host).

### 4.4 Platform wiring

`FirecrackerOrchestrator.streamLogs(handle)` → `host.streamLogs(handle.id)` → `readHvc1(vmId)`.

Same callers as Docker (`run-pipeline.ts`). No changes outside the orchestrator.

---

## 5. Workspace drive

### 5.1 Template build (once at boot)

```
buildWorkspaceTemplate():
  path = FIRECRACKER_WORKSPACE_TEMPLATE_PATH
  if exists(path): return path
  dd if=/dev/zero of=${path} bs=1M count=0 seek=${SIZE_GB}K  // sparse
  mkfs.ext4 -F -q ${path}
  return path
```

Template is built once (boot-time check), reused across all runs.

### 5.2 Per-run creation

```
createWorkspaceDrive(runId):
  target = /var/lib/appstrate/firecracker/workspaces/${runId}.ext4
  if supportsReflink(target's parent dir):
    cp --reflink=always ${template} ${target}   // ~1ms
  else:
    cp ${template} ${target}                    // ~50-200ms depending on size + disk speed
  return target
```

`supportsReflink()`: try `ioctl FICLONE` on a test pair, cache the result per directory.

### 5.3 Cleanup

```
removeWorkspaceDrive(path):
  fs.unlink(path)  // tolerate ENOENT
```

Called from `FirecrackerOrchestrator.removeWorkload` after VM removal.

### 5.4 Sparse file gotcha

The workspace is 10GB sparse — only the blocks written by the VM actually consume host disk. A typical run writes <100MB. Don't warn at "10GB workspace created" — it's mostly air.

Monitor _actual_ usage via `du --apparent-size=false` in observability.

---

## 6. `/inputs` drive

### 6.1 Build

Files come in as `{ name, content: Buffer }[]` (from the `WorkloadSpec.files` field of `createWorkload`).

```
createInputsDrive(runId, files):
  1. mkdir /tmp/inputs-${runId}
  2. for each file: write to /tmp/inputs-${runId}/${file.name}
  3. also write /tmp/inputs-${runId}/etc/hosts.appstrate  (from Phase 3 subnet info)
  4. tar -cf /tmp/inputs-${runId}.tar -C /tmp/inputs-${runId} .
  5. tar2ext4 -i /tmp/inputs-${runId}.tar -o /var/lib/appstrate/firecracker/inputs/${runId}.ext4 -readonly
  6. sha256 = hash of the .ext4 file
  7. rm -rf /tmp/inputs-${runId}{,.tar}
  8. return { path, sha256 }
```

Size: bounded by `WorkloadSpec.files` size + 4KB ext4 overhead. Typical runs: 1-20MB.

### 6.2 Mount inside the VM (init)

```go
// init.go excerpt
syscall.Mount("/dev/vdb", "/inputs", "ext4", syscall.MS_RDONLY, "")

// Merge /etc/hosts fragment
if _, err := os.Stat("/inputs/etc/hosts.appstrate"); err == nil {
    hostsFragment, _ := os.ReadFile("/inputs/etc/hosts.appstrate")
    existing, _ := os.ReadFile("/etc/hosts")
    os.WriteFile("/etc/hosts", append(existing, hostsFragment...), 0644)
}
```

### 6.3 Audit trail

Add to `runs` table:

```ts
// packages/db/src/schema/runs.ts
inputsDriveSha256: text("inputs_drive_sha256"),
```

`FirecrackerOrchestrator.createWorkload` stores the sha256 via an injected update callback (keep the orchestrator DB-free by passing a callback in the constructor, see §9).

---

## 7. Exit code side-channel

Wired end-to-end:

1. Init (Phase 2) writes `exit=N\n` to `/dev/vdd`.
2. Phase 4 properly attaches `/dev/vdd` as a 16-byte sparse file at VM create time (Phase 2 stubbed this).
3. Host-side reader (Phase 4 real impl): on `state: "Stopped"`, read the file, parse, return N.

Drive attach spec:

```
PUT /drives/exit-code
{
  "drive_id": "exit-code",
  "path_on_host": "/srv/jailer/firecracker/${vmId}/root/exit-code",
  "is_read_only": false,
  "is_root_device": false
}
```

Before VM start: `truncate -s 16 /srv/jailer/firecracker/${vmId}/root/exit-code` (creates a 16-byte sparse file; init fills it).

After VM stop: `read exit-code`, parse, delete.

---

## 8. Env additions

No new env vars in Phase 4. All paths are derived from existing `FIRECRACKER_*` env. Keep `packages/env/src/index.ts` untouched unless a knob genuinely needs to be configurable.

---

## 9. Orchestrator changes

`FirecrackerOrchestrator` receives a `RunUpdater` callback in its constructor:

```ts
export interface RunUpdater {
  setInputsDriveSha256(runId: string, sha256: string): Promise<void>;
}

export class FirecrackerOrchestrator implements ContainerOrchestrator {
  constructor(host?: FirecrackerHost, updater?: RunUpdater) {
    // ...
    this.updater = updater ?? defaultRunUpdater;
  }
}
```

`defaultRunUpdater` lives in `apps/api/src/services/firecracker/run-updater.ts` and imports `db` + the runs schema. The orchestrator itself remains DB-free for testability.

Alternative: emit the sha256 via the audit log (Phase 1 mechanism) and have a listener in `run-pipeline.ts` persist it. This decouples even further but adds an eventing dependency. **Pick whichever fits existing patterns in the codebase** — check how `run-pipeline.ts` persists run metadata today.

---

## 10. Tests

### 10.1 Unit (no KVM, no Firecracker)

- `line-buffer.test.ts`: push arbitrary chunks, verify line assembly matches Node's readline semantics.
- `inputs-drive-builder.test.ts`: build an inputs drive from a fixed file set, verify sha256 is deterministic.
- `reflink.test.ts`: detect FS capability, fall back gracefully.

### 10.2 Integration (loopback mount, no KVM)

- `drive-lifecycle.test.ts`:
  - Build inputs drive → mount via `mount -o loop` → assert files present + read-only.
  - Create workspace drive → mount via `mount -o loop` → assert empty + writable.
  - Verify reflink cloning is faster than 20ms (on XFS/btrfs).

### 10.3 KVM-gated

- `log-streaming.test.ts`:
  - Boot a VM that writes 1000 JSON lines to hvc1.
  - Read them via `streamLogs()`, verify order + completeness + no kernel noise.
- `exit-code.test.ts`:
  - Boot agent VM that exits with code 0 → waitForExit → 0.
  - Boot agent VM that exits with code 42 → waitForExit → 42.
  - Boot agent VM that panics → waitForExit → non-zero, no hang.

---

## 11. Implementation order

1. Modify `init.go`: add hvc1 redirect, drive mounts, hosts fragment, exit-code write. Test in isolation.
2. Update the CI rootfs pipeline (Phase 2 workflow) to include the new init. Regenerate `runtime-pi.ext4`.
3. `line-buffer.ts` + `hvc1-reader.ts` + unit tests.
4. `template-builder.ts` + `reflink.ts` + `workspace-drive.ts` + unit tests.
5. `inputs-drive.ts` + unit tests.
6. Wire into `RealFirecrackerHost` (replace Phase 2 stubs).
7. `inputs_drive_sha256` migration + `RunUpdater` wiring.
8. KVM-gated integration tests.
9. Contract re-run: Phase 1 integration suite against the updated real host. All must still pass.
10. Update `CHANGELOG.md`.

---

## 12. Non-goals

- Snapshots, VM pool, image cache → Phase 5
- User-uploaded files into the inputs drive beyond the `WorkloadSpec.files` array → existing upload flow (Docker has it, inherit semantics)
- Log persistence to DB — already handled by `run_logs` at the `run-pipeline` layer, orchestrator just streams
- Workspace persistence across runs — intentionally ephemeral, matches Docker

---

## 13. Risks

| Risk                                                        | Mitigation                                                                                             |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| virtio-console implementation varies by Firecracker version | Pin Firecracker version in health check; fall back to `ttyS1` if virtio-console fails                  |
| Large inputs drive blows tmpfs in `/tmp` build area         | Fail fast if `spec.files` total > `FIRECRACKER_INPUTS_MAX_BYTES` (default 50MB). Match Docker's limits |
| reflink not supported → full copy → slow cold start         | Log warning at boot + instrumentation metric. Operators can pick XFS/btrfs for speed                   |
| init mount bugs leave the VM in a bad state                 | Test the init in a QEMU harness before baking into the rootfs                                          |
| hvc1 pipe fills up if platform reader is slow               | Set a bounded in-memory buffer + log a warning when it saturates                                       |
| sha256 computation on large inputs slow                     | Stream the hash during the tar→ext4 conversion, not after                                              |

---

## 14. Reviewer checklist

- [ ] Platform sees zero kernel noise in the app log stream
- [ ] Inputs drive is mounted RO in the agent; writes fail
- [ ] Workspace drive writes persist during the run, drive deleted after
- [ ] Exit codes propagate (0, 42, non-zero-on-panic)
- [ ] `runs.inputs_drive_sha256` populated
- [ ] Reflink used when supported, fallback works on ext4
- [ ] Phase 1 contract tests still pass against the updated host

## 15. References

- [Firecracker virtio-console](https://github.com/firecracker-microvm/firecracker/blob/main/docs/api_requests/README.md)
- [Linux FICLONE ioctl](https://man7.org/linux/man-pages/man2/ioctl_ficlone.2.html)
- [tar2ext4](https://github.com/microsoft/hcsshim/tree/main/ext4/tar2ext4)
- [Phase 3 spec](./PHASE_3_FIRECRACKER_NETWORKING.md) — prerequisite
