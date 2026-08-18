// SPDX-License-Identifier: Apache-2.0

/**
 * Ground truth for the agent-issued persistence commands.
 *
 * These pin the invariants the previous write path could not hold, each of
 * which was a silent failure rather than a visible one:
 *
 *   - a retried command applies ONCE, whatever the outcome it replays;
 *   - a full archive REFUSES instead of dropping the write while answering
 *     "saved";
 *   - a quota holds under genuine concurrency, not just sequentially;
 *   - two concurrent slot writers cannot overwrite each other unnoticed;
 *   - a deleted actor's run can no longer publish that actor's memories.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";
import { packagePersistence, runPersistenceOperations } from "@appstrate/db/schema";
import {
  appendMemoryCommand,
  hasPersistenceReceipt,
  updateSlotCommand,
  upsertSlotCommand,
} from "../../../src/services/state/persistence-commands.ts";
import {
  MAX_MEMORIES_PER_SCOPE,
  MAX_MEMORY_CONTENT,
  MAX_PINNED_SLOTS_PER_SCOPE,
  type PersistenceScope,
} from "../../../src/services/state/package-persistence.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { seedPackage, seedRun } from "../../helpers/seed.ts";

const AGENT = "@memorg/rememberer";

let ctx: TestContext;
let runId: string;
let scope: PersistenceScope;

/** Shared command envelope — every test varies only what it is testing. */
function base(operationId: string) {
  return {
    runId,
    packageId: AGENT,
    applicationId: ctx.defaultAppId,
    orgId: ctx.orgId,
    scope,
    operationId,
  };
}

async function archiveCount(): Promise<number> {
  const rows = await db
    .select({ id: packagePersistence.id })
    .from(packagePersistence)
    .where(
      and(
        eq(packagePersistence.packageId, AGENT),
        eq(packagePersistence.applicationId, ctx.defaultAppId),
        isNull(packagePersistence.key),
        eq(packagePersistence.pinned, false),
      ),
    );
  return rows.length;
}

beforeEach(async () => {
  await truncateAll();
  ctx = await createTestContext({ orgSlug: "memorg" });
  await seedPackage({ id: AGENT, orgId: ctx.orgId, type: "agent" });
  const run = await seedRun({
    packageId: AGENT,
    orgId: ctx.orgId,
    applicationId: ctx.defaultAppId,
    userId: ctx.user.id,
    actorTypeSnapshot: "user",
    actorIdSnapshot: ctx.user.id,
    status: "running",
  });
  runId = run.id;
  scope = { type: "user", id: ctx.user.id };
});

describe("appendMemoryCommand — idempotency", () => {
  it("a retried operation writes exactly one row", async () => {
    const cmd = { ...base("op-retry"), content: "Gmail paginates at 100 results" };

    const first = await appendMemoryCommand(db, cmd);
    const second = await appendMemoryCommand(db, cmd);

    expect(first.outcome).toBe("committed");
    expect(second.outcome).toBe("committed");
    // The retry is the whole point: same logical write, one row. Content
    // comparison could never establish this — two identical notes are
    // legitimately distinct entries.
    expect(await archiveCount()).toBe(1);
  });

  it("distinct operations on identical content both write", async () => {
    await appendMemoryCommand(db, { ...base("op-a"), content: "same text" });
    await appendMemoryCommand(db, { ...base("op-b"), content: "same text" });

    expect(await archiveCount()).toBe(2);
  });

  it("a retried refusal replays the refusal, and never becomes a write", async () => {
    const cmd = { ...base("op-toolong"), content: "x".repeat(MAX_MEMORY_CONTENT + 1) };

    const first = await appendMemoryCommand(db, cmd);
    const second = await appendMemoryCommand(db, cmd);

    expect(first.outcome).toBe("rejected");
    expect(second.outcome).toBe("rejected");
    expect(await archiveCount()).toBe(0);
  });

  it("records a receipt the terminal path can observe", async () => {
    await appendMemoryCommand(db, { ...base("op-receipt"), content: "note" });

    expect(await hasPersistenceReceipt(db, runId, "op-receipt")).toBe(true);
    expect(await hasPersistenceReceipt(db, runId, "never-issued")).toBe(false);
  });
});

describe("appendMemoryCommand — bounds are refusals, not silent drops", () => {
  it("refuses past the archive cap instead of dropping the write", async () => {
    for (let i = 0; i < MAX_MEMORIES_PER_SCOPE; i++) {
      const result = await appendMemoryCommand(db, { ...base(`fill-${i}`), content: `m${i}` });
      expect(result.outcome).toBe("committed");
    }

    const overflow = await appendMemoryCommand(db, {
      ...base("overflow"),
      content: "one too many",
    });

    expect(overflow).toMatchObject({ outcome: "rejected", reason: "quota_exceeded" });
    expect(await archiveCount()).toBe(MAX_MEMORIES_PER_SCOPE);
  });

  it("refuses over-long content instead of truncating it", async () => {
    const result = await appendMemoryCommand(db, {
      ...base("op-long"),
      content: "y".repeat(MAX_MEMORY_CONTENT + 1),
    });

    expect(result).toMatchObject({ outcome: "rejected", reason: "content_too_large" });
    expect(await archiveCount()).toBe(0);
  });

  it("a pinned memo does not consume the archive allowance", async () => {
    // The archive cap is an ARCHIVE allowance. The count predicate used to
    // omit `pinned = false`, so a row in the (key IS NULL, pinned = true)
    // quadrant silently shrank every agent's budget.
    await db.insert(packagePersistence).values({
      packageId: AGENT,
      applicationId: ctx.defaultAppId,
      orgId: ctx.orgId,
      key: null,
      pinned: true,
      actorType: "user",
      actorId: ctx.user.id,
      content: "pinned memo" as unknown as Record<string, unknown>,
    });

    for (let i = 0; i < MAX_MEMORIES_PER_SCOPE; i++) {
      const result = await appendMemoryCommand(db, { ...base(`fill-${i}`), content: `m${i}` });
      expect(result.outcome).toBe("committed");
    }

    expect(await archiveCount()).toBe(MAX_MEMORIES_PER_SCOPE);
  });
});

describe("appendMemoryCommand — concurrency", () => {
  it("parallel writes at the cap boundary never exceed it", async () => {
    for (let i = 0; i < MAX_MEMORIES_PER_SCOPE - 2; i++) {
      await appendMemoryCommand(db, { ...base(`fill-${i}`), content: `m${i}` });
    }

    // Ten writers racing for two remaining slots. A bare
    // `INSERT … WHERE (SELECT count(*)) < cap` passes this test sequentially
    // and fails it here: under READ COMMITTED every racer reads the same
    // pre-insert count.
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        appendMemoryCommand(db, { ...base(`race-${i}`), content: `race ${i}` }),
      ),
    );

    const committed = results.filter((r) => r.outcome === "committed").length;
    expect(committed).toBe(2);
    expect(await archiveCount()).toBe(MAX_MEMORIES_PER_SCOPE);
  });
});

describe("slot commands — optimistic concurrency", () => {
  it("upsert bumps the revision on every committed write", async () => {
    const first = await upsertSlotCommand(db, { ...base("s1"), key: "goals", content: { a: 1 } });
    const second = await upsertSlotCommand(db, { ...base("s2"), key: "goals", content: { a: 2 } });

    expect(first).toMatchObject({ outcome: "committed", revision: 1 });
    expect(second).toMatchObject({ outcome: "committed", revision: 2 });
  });

  it("a stale expected_revision conflicts and returns the current value", async () => {
    await upsertSlotCommand(db, { ...base("s1"), key: "goals", content: { step: 1 } });
    await upsertSlotCommand(db, { ...base("s2"), key: "goals", content: { step: 2 } });

    // Writer still holding revision 1 — the losing side of what used to be a
    // silent overwrite.
    const stale = await updateSlotCommand(db, {
      ...base("s3"),
      key: "goals",
      patch: { type: "merge", value: { note: "from the stale writer" } },
      expectedRevision: 1,
    });

    expect(stale.outcome).toBe("conflict");
    if (stale.outcome === "conflict") {
      expect(stale.revision).toBe(2);
      // The current value comes back so the agent can replay its patch on top
      // instead of losing the write.
      expect(stale.currentContent).toEqual({ step: 2 });
    }
  });

  it("a matching expected_revision applies the patch without a full rewrite", async () => {
    await upsertSlotCommand(db, {
      ...base("s1"),
      key: "state",
      content: { cursor: 10, label: "keep me" },
    });

    const patched = await updateSlotCommand(db, {
      ...base("s2"),
      key: "state",
      patch: { type: "merge", value: { cursor: 20 } },
      expectedRevision: 1,
    });

    expect(patched).toMatchObject({ outcome: "committed", revision: 2 });

    const [row] = await db
      .select({ content: packagePersistence.content })
      .from(packagePersistence)
      .where(
        and(
          eq(packagePersistence.packageId, AGENT),
          eq(packagePersistence.key, "state"),
          eq(packagePersistence.actorId, ctx.user.id),
        ),
      );
    // The untouched member survives — that is what "partial" means here.
    expect(row!.content).toEqual({ cursor: 20, label: "keep me" });
  });

  it("only one of two concurrent patches on the same revision commits", async () => {
    await upsertSlotCommand(db, { ...base("s1"), key: "counter", content: { n: 0 } });

    const [a, b] = await Promise.all([
      updateSlotCommand(db, {
        ...base("s-a"),
        key: "counter",
        patch: { type: "merge", value: { n: 1 } },
        expectedRevision: 1,
      }),
      updateSlotCommand(db, {
        ...base("s-b"),
        key: "counter",
        patch: { type: "merge", value: { n: 2 } },
        expectedRevision: 1,
      }),
    ]);

    const outcomes = [a!.outcome, b!.outcome].sort();
    // Exactly one winner and one recoverable conflict — never two silent
    // winners, which is what last-write-wins produced.
    expect(outcomes).toEqual(["committed", "conflict"]);
  });

  it("expected_revision 0 creates, and conflicts once the slot exists", async () => {
    const created = await updateSlotCommand(db, {
      ...base("s1"),
      key: "fresh",
      patch: { type: "merge", value: { hello: "world" } },
      expectedRevision: 0,
    });
    expect(created).toMatchObject({ outcome: "committed", revision: 1 });

    const again = await updateSlotCommand(db, {
      ...base("s2"),
      key: "fresh",
      patch: { type: "merge", value: { hello: "again" } },
      expectedRevision: 0,
    });
    expect(again.outcome).toBe("conflict");
  });

  it("refuses a new slot past the cap but keeps existing slots writable", async () => {
    for (let i = 0; i < MAX_PINNED_SLOTS_PER_SCOPE; i++) {
      const r = await upsertSlotCommand(db, {
        ...base(`slot-${i}`),
        key: `slot_${i}`,
        content: { i },
      });
      expect(r.outcome).toBe("committed");
    }

    const overflow = await upsertSlotCommand(db, {
      ...base("slot-overflow"),
      key: "one_too_many",
      content: {},
    });
    expect(overflow).toMatchObject({ outcome: "rejected", reason: "slot_quota_exceeded" });

    // Crossing the cap must not freeze state the agent already depends on.
    const existing = await upsertSlotCommand(db, {
      ...base("slot-existing"),
      key: "slot_0",
      content: { updated: true },
    });
    expect(existing.outcome).toBe("committed");
  });

  it("keeps actor and shared slots of the same name distinct", async () => {
    await upsertSlotCommand(db, { ...base("s1"), key: "persona", content: "mine" });
    await upsertSlotCommand(db, {
      ...base("s2"),
      scope: { type: "shared" },
      key: "persona",
      content: "everyone's",
    });

    const rows = await db
      .select({ actorType: packagePersistence.actorType, content: packagePersistence.content })
      .from(packagePersistence)
      .where(and(eq(packagePersistence.packageId, AGENT), eq(packagePersistence.key, "persona")));

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.actorType).sort()).toEqual(["shared", "user"]);
  });
});

describe("actor lifecycle", () => {
  it("refuses to write for an actor that no longer exists", async () => {
    const goneScope: PersistenceScope = { type: "end_user", id: "eu_deleted" };

    const result = await appendMemoryCommand(db, {
      ...base("op-gone"),
      scope: goneScope,
      content: "should never land",
    });

    // Without this the run would keep writing rows keyed to a deleted
    // identity — rows no purge will ever revisit.
    expect(result).toMatchObject({ outcome: "rejected", reason: "actor_gone" });
    expect(await archiveCount()).toBe(0);
  });

  it("still accepts shared writes, which belong to the application", async () => {
    const result = await appendMemoryCommand(db, {
      ...base("op-shared"),
      scope: { type: "shared" },
      content: "an app-wide fact",
    });

    expect(result.outcome).toBe("committed");
  });
});

describe("receipts", () => {
  it("record the resolved scope so a retry cannot land elsewhere", async () => {
    await appendMemoryCommand(db, { ...base("op-scope"), content: "note" });

    const [receipt] = await db
      .select()
      .from(runPersistenceOperations)
      .where(
        and(
          eq(runPersistenceOperations.runId, runId),
          eq(runPersistenceOperations.operationId, "op-scope"),
        ),
      );

    expect(receipt).toMatchObject({
      kind: "memory",
      outcome: "committed",
      actorType: "user",
      actorId: ctx.user.id,
    });
  });
});
