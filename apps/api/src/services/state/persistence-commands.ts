// SPDX-License-Identifier: Apache-2.0

/**
 * Agent-issued persistence commands — the single transactional writer behind
 * every memory and pinned-slot mutation, whatever transport carried it.
 *
 * ## Why a command service and not "a couple of routes"
 *
 * The agent's write travels over the network, so this sequence is inevitable:
 * the command commits, the response is lost, the runtime retries. Comparing
 * content cannot dedupe that — two identical notes are legitimately distinct.
 * Every command therefore carries a runtime-minted `operationId`, replayed
 * verbatim across retries, and this module records a durable receipt
 * (`run_persistence_operations`) inside the SAME transaction as the mutation.
 * A retry becomes a receipt lookup that replays the original answer.
 *
 * That receipt is also what lets three transports coexist without ever
 * double-applying one logical write:
 *
 *   1. **command**   — `POST /internal/memory|slots`. Source of truth.
 *   2. **ingestion**  — the canonical `memory.added` / `pinned.set` event
 *      mutates only when no receipt claims its `operationId` (older runtime
 *      images that never call the command routes).
 *   3. **finalize**   — replays only what neither of the above committed.
 *
 * ## Why every entry point takes an explicit executor
 *
 * The pre-existing helpers in `package-persistence.ts` capture the global `db`
 * handle. Calling them from the ingestion dispatcher would run them OUTSIDE
 * its CAS transaction — the sequence advance could roll back while the memory
 * write stayed committed. Commands here accept `Db | DbTx` so the caller
 * decides the transaction boundary, and `runInTransaction` guarantees one
 * exists either way.
 *
 * ## Concurrency
 *
 * Quota admission and slot revision bumps are serialised per scope with a
 * transaction-scoped advisory lock (same pattern as `acquireRunNumberLock` in
 * `state/runs.ts`). A bare `INSERT … WHERE (SELECT count(*)) < cap` does NOT
 * hold under `READ COMMITTED`: two transactions both read `cap - 1` and both
 * insert. The lock is the only thing that makes the cap true.
 */

import { and, count, eq, isNull, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import type { Db } from "@appstrate/db/client";
import { endUsers, packagePersistence, runPersistenceOperations, user } from "@appstrate/db/schema";
import { packagePersistenceContentSchema } from "../../lib/jsonb-schemas.ts";
import {
  CHECKPOINT_KEY,
  MAX_MEMORY_CONTENT,
  MAX_MEMORIES_PER_SCOPE,
  MAX_PINNED_KEY_LENGTH,
  MAX_PINNED_SLOTS_PER_SCOPE,
  PINNED_KEY_PATTERN,
  type PersistenceScope,
} from "./package-persistence.ts";

/** Drizzle transaction handle — mirrors the local alias used in `state/runs.ts`. */
type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type PersistenceExecutor = Db | DbTx;

/** Machine-readable refusal causes, surfaced verbatim to the agent. */
export type PersistenceRejectReason =
  | "quota_exceeded"
  | "slot_quota_exceeded"
  | "content_too_large"
  | "invalid_content"
  | "invalid_key"
  | "actor_gone"
  | "patch_not_applicable";

export type MemoryCommandResult =
  | { outcome: "committed"; memoryId: number }
  | { outcome: "rejected"; reason: PersistenceRejectReason; detail: string };

export type SlotCommandResult =
  /**
   * `content` is the slot's value AFTER the write. It travels back because the
   * caller may not know it: a patch is resolved server-side, and the canonical
   * `pinned.set` event the runtime emits must describe what was actually
   * stored rather than the fragment that was sent.
   */
  | { outcome: "committed"; revision: number; content: unknown }
  | { outcome: "conflict"; revision: number; currentContent: unknown }
  | { outcome: "rejected"; reason: PersistenceRejectReason; detail: string };

interface CommandBase {
  runId: string;
  packageId: string;
  applicationId: string;
  orgId: string;
  scope: PersistenceScope;
  /** Runtime-minted idempotency key, stable across retries of one write. */
  operationId: string;
}

export interface AppendMemoryCommand extends CommandBase {
  content: unknown;
}

export interface UpsertSlotCommand extends CommandBase {
  key: string;
  content: unknown;
}

export interface UpdateSlotCommand extends CommandBase {
  key: string;
  patch: SlotPatch;
  /**
   * Revision the agent believes it is editing. `0` means "create only" — the
   * command commits when the slot does not exist yet and conflicts when it
   * does, so a patch can never silently become the slot's first value.
   */
  expectedRevision: number;
}

/**
 * A partial slot mutation. Both shapes exist because slots hold two very
 * different payloads: structured state (merge by key) and prose (replace an
 * anchored fragment).
 */
export type SlotPatch =
  { type: "merge"; value: Record<string, unknown> } | { type: "replace"; old: string; new: string };

// ---------------------------------------------------------------------------
// Scope helpers
// ---------------------------------------------------------------------------

function storageActor(scope: PersistenceScope): {
  actorType: "user" | "end_user" | "shared";
  actorId: string | null;
} {
  if (scope.type === "shared") return { actorType: "shared", actorId: null };
  if (scope.type === "end_user") return { actorType: "end_user", actorId: scope.id };
  return { actorType: "user", actorId: scope.id };
}

function scopeFilter(scope: PersistenceScope) {
  const { actorType, actorId } = storageActor(scope);
  return actorType === "shared"
    ? and(eq(packagePersistence.actorType, "shared"), isNull(packagePersistence.actorId))
    : and(eq(packagePersistence.actorType, actorType), eq(packagePersistence.actorId, actorId!));
}

/**
 * Serialise everything that reads-then-writes a scope's row counts. Keyed on
 * the exact tuple the caps are defined over, so two different scopes never
 * block each other.
 */
async function acquireScopeLock(
  tx: DbTx,
  packageId: string,
  applicationId: string,
  scope: PersistenceScope,
): Promise<void> {
  const { actorType, actorId } = storageActor(scope);
  const lockKey = `pkp:${packageId}:${applicationId}:${actorType}:${actorId ?? "__shared__"}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey})::bigint)`);
}

/**
 * Reject a write whose actor no longer exists.
 *
 * Deleting an actor nulls `runs.user_id` / `runs.end_user_id` (both are
 * `ON DELETE SET NULL`) but cannot reach a run already in flight. Without this
 * check that run would keep writing rows keyed to a deleted identity — rows no
 * purge will ever revisit. `shared` is always valid: it belongs to the
 * application, not to a person.
 */
async function actorStillExists(tx: DbTx, scope: PersistenceScope): Promise<boolean> {
  if (scope.type === "shared") return true;
  const table = scope.type === "end_user" ? endUsers : user;
  const rows = await tx.select({ id: table.id }).from(table).where(eq(table.id, scope.id)).limit(1);
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

type ReceiptRow = {
  outcome: "committed" | "rejected" | "conflict";
  committedRevision: number | null;
  reason: string | null;
};

async function findReceipt(
  tx: DbTx,
  runId: string,
  operationId: string,
): Promise<ReceiptRow | null> {
  const rows = await tx
    .select({
      outcome: runPersistenceOperations.outcome,
      committedRevision: runPersistenceOperations.committedRevision,
      reason: runPersistenceOperations.reason,
    })
    .from(runPersistenceOperations)
    .where(
      and(
        eq(runPersistenceOperations.runId, runId),
        eq(runPersistenceOperations.operationId, operationId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function writeReceipt(
  tx: DbTx,
  cmd: CommandBase,
  kind: "memory" | "slot",
  outcome: "committed" | "rejected" | "conflict",
  extra: { revision?: number | null; targetKey?: string | null; reason?: string | null } = {},
): Promise<void> {
  const { actorType, actorId } = storageActor(cmd.scope);
  await tx.insert(runPersistenceOperations).values({
    runId: cmd.runId,
    operationId: cmd.operationId,
    kind,
    outcome,
    committedRevision: extra.revision ?? null,
    targetKey: extra.targetKey ?? null,
    actorType,
    actorId,
    reason: extra.reason ?? null,
  });
}

/**
 * True when this run has already applied `operationId`.
 *
 * Read-only probe used by the ingestion and finalize transports to decide
 * whether the command route already handled a write. Deliberately does NOT
 * take a lock: a false negative degrades into the command path's own receipt
 * insert failing on the unique index, which is still safe.
 */
export async function hasPersistenceReceipt(
  executor: PersistenceExecutor,
  runId: string,
  operationId: string,
): Promise<boolean> {
  const rows = await executor
    .select({ id: runPersistenceOperations.id })
    .from(runPersistenceOperations)
    .where(
      and(
        eq(runPersistenceOperations.runId, runId),
        eq(runPersistenceOperations.operationId, operationId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Run `fn` inside a transaction, reusing the caller's when it already has one.
 *
 * Drizzle's transaction handle exposes `.transaction()` too, so nesting would
 * silently open a SAVEPOINT and break the "one atomic unit" contract the
 * receipts rely on. The `isTx` probe keeps a single boundary.
 */
async function runInTransaction<T>(
  executor: PersistenceExecutor,
  fn: (tx: DbTx) => Promise<T>,
): Promise<T> {
  const isTx = "rollback" in executor;
  if (isTx) return fn(executor as DbTx);
  return (executor as Db).transaction(fn);
}

// ---------------------------------------------------------------------------
// Content validation
// ---------------------------------------------------------------------------

function validateContent(value: unknown): { ok: true } | { ok: false; detail: string } {
  const parsed = packagePersistenceContentSchema.safeParse(value);
  if (parsed.success) return { ok: true };
  return { ok: false, detail: parsed.error.issues[0]?.message ?? "JSON validation failed" };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Append one archive memory (`key IS NULL`, `pinned = false`).
 *
 * Refuses rather than truncates. The previous behaviour silently cut content
 * at {@link MAX_MEMORY_CONTENT} and silently dropped the row once the scope was
 * full, both while answering "Note saved" — the agent had no way to learn its
 * memory did not exist.
 */
export async function appendMemoryCommand(
  executor: PersistenceExecutor,
  cmd: AppendMemoryCommand,
): Promise<MemoryCommandResult> {
  return runInTransaction(executor, async (tx) => {
    const replay = await findReceipt(tx, cmd.runId, cmd.operationId);
    if (replay) return replayMemory(replay);

    if (typeof cmd.content === "string" && cmd.content.length > MAX_MEMORY_CONTENT) {
      const detail = `Memory content exceeds ${MAX_MEMORY_CONTENT} characters (got ${cmd.content.length}). Shorten it and call again.`;
      await writeReceipt(tx, cmd, "memory", "rejected", { reason: "content_too_large" });
      return { outcome: "rejected", reason: "content_too_large", detail };
    }

    const valid = validateContent(cmd.content);
    if (!valid.ok) {
      await writeReceipt(tx, cmd, "memory", "rejected", { reason: "invalid_content" });
      return { outcome: "rejected", reason: "invalid_content", detail: valid.detail };
    }

    await acquireScopeLock(tx, cmd.packageId, cmd.applicationId, cmd.scope);

    if (!(await actorStillExists(tx, cmd.scope))) {
      await writeReceipt(tx, cmd, "memory", "rejected", { reason: "actor_gone" });
      return {
        outcome: "rejected",
        reason: "actor_gone",
        detail: "The actor this run belongs to no longer exists; memory was not saved.",
      };
    }

    // `pinned = false` is load-bearing: the archive cap must count archive rows
    // only. Without it a pinned memo would consume the budget presented to the
    // agent as its archive allowance.
    const [row] = await tx
      .select({ count: count() })
      .from(packagePersistence)
      .where(
        and(
          eq(packagePersistence.packageId, cmd.packageId),
          eq(packagePersistence.applicationId, cmd.applicationId),
          isNull(packagePersistence.key),
          eq(packagePersistence.pinned, false),
          scopeFilter(cmd.scope),
        ),
      );

    if ((row?.count ?? 0) >= MAX_MEMORIES_PER_SCOPE) {
      const detail = `Archive is full (${MAX_MEMORIES_PER_SCOPE} memories for this scope). Delete some before saving new ones.`;
      await writeReceipt(tx, cmd, "memory", "rejected", { reason: "quota_exceeded" });
      return { outcome: "rejected", reason: "quota_exceeded", detail };
    }

    const { actorType, actorId } = storageActor(cmd.scope);
    const [inserted] = await tx
      .insert(packagePersistence)
      .values({
        packageId: cmd.packageId,
        applicationId: cmd.applicationId,
        orgId: cmd.orgId,
        key: null,
        pinned: false,
        actorType,
        actorId,
        content: cmd.content as Record<string, unknown>,
        runId: cmd.runId,
      })
      .returning({ id: packagePersistence.id });

    await writeReceipt(tx, cmd, "memory", "committed");
    return { outcome: "committed", memoryId: inserted!.id };
  });
}

function replayMemory(receipt: ReceiptRow): MemoryCommandResult {
  if (receipt.outcome === "committed") return { outcome: "committed", memoryId: -1 };
  return {
    outcome: "rejected",
    reason: (receipt.reason as PersistenceRejectReason) ?? "invalid_content",
    detail: "Replayed from a previous attempt of this same operation.",
  };
}

function validateKey(key: string): { ok: true } | { ok: false; detail: string } {
  if (
    typeof key !== "string" ||
    key.length === 0 ||
    key.length > MAX_PINNED_KEY_LENGTH ||
    !PINNED_KEY_PATTERN.test(key)
  ) {
    return {
      ok: false,
      detail: `Invalid slot key "${key}" — lowercase letters, digits and underscores only, at most ${MAX_PINNED_KEY_LENGTH} characters.`,
    };
  }
  return { ok: true };
}

/**
 * Unconditional slot upsert — the `pin` tool's semantics. Last write wins per
 * `(scope, key)`, and the revision advances so a concurrent
 * {@link updateSlotCommand} can detect that it did.
 */
export async function upsertSlotCommand(
  executor: PersistenceExecutor,
  cmd: UpsertSlotCommand,
): Promise<SlotCommandResult> {
  return runInTransaction(executor, async (tx) => {
    const replay = await findReceipt(tx, cmd.runId, cmd.operationId);
    if (replay) return replaySlot(replay);

    const key = validateKey(cmd.key);
    if (!key.ok) {
      await writeReceipt(tx, cmd, "slot", "rejected", { reason: "invalid_key" });
      return { outcome: "rejected", reason: "invalid_key", detail: key.detail };
    }

    const valid = validateContent(cmd.content);
    if (!valid.ok) {
      await writeReceipt(tx, cmd, "slot", "rejected", {
        reason: "invalid_content",
        targetKey: cmd.key,
      });
      return { outcome: "rejected", reason: "invalid_content", detail: valid.detail };
    }

    await acquireScopeLock(tx, cmd.packageId, cmd.applicationId, cmd.scope);

    if (!(await actorStillExists(tx, cmd.scope))) {
      await writeReceipt(tx, cmd, "slot", "rejected", {
        reason: "actor_gone",
        targetKey: cmd.key,
      });
      return {
        outcome: "rejected",
        reason: "actor_gone",
        detail: "The actor this run belongs to no longer exists; the slot was not written.",
      };
    }

    const existing = await readSlot(tx, cmd.packageId, cmd.applicationId, cmd.scope, cmd.key);

    // Slot-count cap applies to CREATION only: an existing slot must always
    // remain writable, otherwise crossing the cap would freeze state the agent
    // is already depending on. `checkpoint` is exempt — it is the platform's
    // own carry-over slot, not agent-invented namespace growth.
    if (!existing && cmd.key !== CHECKPOINT_KEY) {
      const overflow = await slotCountExceeded(tx, cmd);
      if (overflow) {
        await writeReceipt(tx, cmd, "slot", "rejected", {
          reason: "slot_quota_exceeded",
          targetKey: cmd.key,
        });
        return { outcome: "rejected", reason: "slot_quota_exceeded", detail: overflow };
      }
    }

    const revision = await writeSlot(tx, cmd, cmd.content, existing?.revision ?? 0);
    await writeReceipt(tx, cmd, "slot", "committed", { revision, targetKey: cmd.key });
    return { outcome: "committed", revision, content: cmd.content };
  });
}

/**
 * Conditional, partial slot write — the primitive that removes whole-value
 * rewrites and turns the silent lost-update into a recoverable conflict.
 *
 * A mismatched `expectedRevision` returns the current revision AND value so
 * the agent can replay its patch on top instead of losing the write.
 */
export async function updateSlotCommand(
  executor: PersistenceExecutor,
  cmd: UpdateSlotCommand,
): Promise<SlotCommandResult> {
  return runInTransaction(executor, async (tx) => {
    const replay = await findReceipt(tx, cmd.runId, cmd.operationId);
    if (replay) return replaySlot(replay);

    const key = validateKey(cmd.key);
    if (!key.ok) {
      await writeReceipt(tx, cmd, "slot", "rejected", { reason: "invalid_key" });
      return { outcome: "rejected", reason: "invalid_key", detail: key.detail };
    }

    await acquireScopeLock(tx, cmd.packageId, cmd.applicationId, cmd.scope);

    if (!(await actorStillExists(tx, cmd.scope))) {
      await writeReceipt(tx, cmd, "slot", "rejected", {
        reason: "actor_gone",
        targetKey: cmd.key,
      });
      return {
        outcome: "rejected",
        reason: "actor_gone",
        detail: "The actor this run belongs to no longer exists; the slot was not written.",
      };
    }

    const existing = await readSlot(tx, cmd.packageId, cmd.applicationId, cmd.scope, cmd.key);
    const currentRevision = existing?.revision ?? 0;

    if (currentRevision !== cmd.expectedRevision) {
      await writeReceipt(tx, cmd, "slot", "conflict", {
        revision: currentRevision,
        targetKey: cmd.key,
      });
      return {
        outcome: "conflict",
        revision: currentRevision,
        currentContent: existing?.content ?? null,
      };
    }

    if (!existing && cmd.key !== CHECKPOINT_KEY) {
      const overflow = await slotCountExceeded(tx, cmd);
      if (overflow) {
        await writeReceipt(tx, cmd, "slot", "rejected", {
          reason: "slot_quota_exceeded",
          targetKey: cmd.key,
        });
        return { outcome: "rejected", reason: "slot_quota_exceeded", detail: overflow };
      }
    }

    const applied = applyPatch(existing?.content ?? null, cmd.patch);
    if (!applied.ok) {
      await writeReceipt(tx, cmd, "slot", "rejected", {
        reason: "patch_not_applicable",
        targetKey: cmd.key,
      });
      return { outcome: "rejected", reason: "patch_not_applicable", detail: applied.detail };
    }

    const valid = validateContent(applied.value);
    if (!valid.ok) {
      await writeReceipt(tx, cmd, "slot", "rejected", {
        reason: "invalid_content",
        targetKey: cmd.key,
      });
      return { outcome: "rejected", reason: "invalid_content", detail: valid.detail };
    }

    const revision = await writeSlot(tx, cmd, applied.value, currentRevision);
    await writeReceipt(tx, cmd, "slot", "committed", { revision, targetKey: cmd.key });
    return { outcome: "committed", revision, content: applied.value };
  });
}

function replaySlot(receipt: ReceiptRow): SlotCommandResult {
  if (receipt.outcome === "committed") {
    // A replay cannot reconstruct the stored value from the receipt alone; the
    // caller re-reads if it needs it. The revision is what retries care about.
    return { outcome: "committed", revision: receipt.committedRevision ?? 1, content: undefined };
  }
  if (receipt.outcome === "conflict") {
    return {
      outcome: "conflict",
      revision: receipt.committedRevision ?? 0,
      currentContent: null,
    };
  }
  return {
    outcome: "rejected",
    reason: (receipt.reason as PersistenceRejectReason) ?? "invalid_content",
    detail: "Replayed from a previous attempt of this same operation.",
  };
}

async function readSlot(
  tx: DbTx,
  packageId: string,
  applicationId: string,
  scope: PersistenceScope,
  key: string,
): Promise<{ revision: number; content: unknown } | null> {
  const rows = await tx
    .select({ revision: packagePersistence.revision, content: packagePersistence.content })
    .from(packagePersistence)
    .where(
      and(
        eq(packagePersistence.packageId, packageId),
        eq(packagePersistence.applicationId, applicationId),
        eq(packagePersistence.key, key),
        scopeFilter(scope),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function slotCountExceeded(tx: DbTx, cmd: CommandBase): Promise<string | null> {
  const [row] = await tx
    .select({ count: count() })
    .from(packagePersistence)
    .where(
      and(
        eq(packagePersistence.packageId, cmd.packageId),
        eq(packagePersistence.applicationId, cmd.applicationId),
        sql`${packagePersistence.key} IS NOT NULL`,
        scopeFilter(cmd.scope),
      ),
    );
  if ((row?.count ?? 0) < MAX_PINNED_SLOTS_PER_SCOPE) return null;
  return `Slot limit reached (${MAX_PINNED_SLOTS_PER_SCOPE} named slots for this scope). Reuse or delete an existing slot instead of creating a new one.`;
}

/**
 * Insert-or-update the slot and return its new revision.
 *
 * Hand-written SQL because the unique index is expression-based
 * (`COALESCE(actor_id, '__shared__')`), and Drizzle's `onConflictDoUpdate`
 * cannot express that conflict target — the columns must match the index
 * byte-for-byte.
 */
async function writeSlot(
  tx: DbTx,
  cmd: CommandBase & { key: string },
  content: unknown,
  currentRevision: number,
): Promise<number> {
  const { actorType, actorId } = storageActor(cmd.scope);
  const contentJson = sql`${JSON.stringify(content ?? null)}::jsonb`;
  const nextRevision = currentRevision + 1;
  await tx.execute(sql`
    INSERT INTO ${packagePersistence}
      (package_id, application_id, org_id, key, pinned, actor_type, actor_id, content, revision, run_id, created_at, updated_at)
    VALUES
      (${cmd.packageId}, ${cmd.applicationId}, ${cmd.orgId}, ${cmd.key}, true, ${actorType}, ${actorId}, ${contentJson}, ${nextRevision}, ${cmd.runId}, NOW(), NOW())
    ON CONFLICT (package_id, application_id, actor_type, (COALESCE(actor_id, '__shared__')), key) WHERE key IS NOT NULL
    DO UPDATE SET
      content    = EXCLUDED.content,
      revision   = ${packagePersistence}.revision + 1,
      run_id     = EXCLUDED.run_id,
      updated_at = NOW()
  `);
  return nextRevision;
}

// ---------------------------------------------------------------------------
// Patch application
// ---------------------------------------------------------------------------

/**
 * Apply a partial mutation to a slot value.
 *
 * `merge` follows JSON Merge Patch (RFC 7386) semantics at the top level: a
 * `null` member deletes the key, any other value replaces it. `replace` is an
 * anchored text edit that MUST match exactly once — zero matches means the
 * agent's assumption about the current text was wrong, and several matches
 * means the edit is ambiguous. Both are refusals rather than guesses.
 */
export function applyPatch(
  current: unknown,
  patch: SlotPatch,
): { ok: true; value: unknown } | { ok: false; detail: string } {
  if (patch.type === "merge") {
    if (current !== null && current !== undefined && !isPlainObject(current)) {
      return {
        ok: false,
        detail: "Cannot merge into this slot: its current value is not a JSON object.",
      };
    }
    const base: Record<string, unknown> = isPlainObject(current) ? { ...current } : {};
    for (const [k, v] of Object.entries(patch.value)) {
      if (v === null) delete base[k];
      else base[k] = v;
    }
    return { ok: true, value: base };
  }

  if (typeof current !== "string") {
    return {
      ok: false,
      detail: "Cannot apply a text replacement: this slot does not hold a string.",
    };
  }
  if (patch.old.length === 0) {
    return { ok: false, detail: "The text to replace must not be empty." };
  }
  const occurrences = countOccurrences(current, patch.old);
  if (occurrences === 0) {
    return {
      ok: false,
      detail: "The text to replace was not found in the slot's current value.",
    };
  }
  if (occurrences > 1) {
    return {
      ok: false,
      detail: `The text to replace appears ${occurrences} times — include more surrounding context so it matches exactly once.`,
    };
  }
  return { ok: true, value: current.replace(patch.old, patch.new) };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function countOccurrences(haystack: string, needle: string): number {
  let total = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    total += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return total;
}
