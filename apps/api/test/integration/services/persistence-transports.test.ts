// SPDX-License-Identifier: Apache-2.0

/**
 * One logical write, three transports, one mutation.
 *
 * A memory write can reach the platform three ways, and during a rollout all
 * three are live at once:
 *
 *   1. the command route, called by a current runtime image;
 *   2. the canonical event, for a runtime whose command call never landed;
 *   3. the terminal aggregate, for a runtime image predating the routes.
 *
 * The receipt is what arbitrates. These tests pin the arbitration, because
 * getting it wrong is invisible at runtime: nothing errors, the agent simply
 * ends up with two copies of a memory it saved once — or none.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";
import { packagePersistence } from "@appstrate/db/schema";
import { appendMemoryCommand } from "../../../src/services/state/persistence-commands.ts";
import { addMemories } from "../../../src/services/state/package-persistence.ts";
import { persistRunEvent } from "../../../src/services/run-launcher/appstrate-event-sink.ts";
import { hasPersistenceReceipt } from "../../../src/services/state/persistence-commands.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { seedPackage, seedRun } from "../../helpers/seed.ts";
import type { RunEvent } from "@appstrate/afps-runtime/types";

const AGENT = "@transportorg/agent";

let ctx: TestContext;
let runId: string;

async function archiveRows() {
  return db
    .select({ content: packagePersistence.content })
    .from(packagePersistence)
    .where(
      and(
        eq(packagePersistence.packageId, AGENT),
        isNull(packagePersistence.key),
        eq(packagePersistence.pinned, false),
      ),
    );
}

/** Feed one canonical event through the ingestion dispatcher. */
async function ingest(event: Record<string, unknown>) {
  await persistRunEvent(
    db,
    { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
    runId,
    { runId, timestamp: Date.now(), ...event } as unknown as RunEvent,
    { persistence: { packageId: AGENT, scope: { type: "user", id: ctx.user.id } } },
  );
}

beforeEach(async () => {
  await truncateAll();
  ctx = await createTestContext({ orgSlug: "transportorg" });
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
});

describe("command then event", () => {
  it("the event does not re-apply a write the command committed", async () => {
    await appendMemoryCommand(db, {
      runId,
      packageId: AGENT,
      applicationId: ctx.defaultAppId,
      orgId: ctx.orgId,
      scope: { type: "user", id: ctx.user.id },
      operationId: "op-1",
      content: "learned something",
    });

    // The runtime emits the event AFTER its command committed — an observation
    // of a fact, not the write itself.
    await ingest({ type: "memory.added", content: "learned something", operationId: "op-1" });

    expect(await archiveRows()).toHaveLength(1);
  });
});

describe("event without a preceding command", () => {
  it("applies the write and leaves a receipt behind", async () => {
    // The command call never landed (transport failure), so the event is the
    // only remaining carrier — the ingestion transport must pick it up.
    await ingest({ type: "memory.added", content: "fallback path", operationId: "op-2" });

    expect(await archiveRows()).toHaveLength(1);
    // The receipt is what will stop the terminal path replaying it.
    expect(await hasPersistenceReceipt(db, runId, "op-2")).toBe(true);
  });

  it("is idempotent when the same event is redelivered", async () => {
    await ingest({ type: "memory.added", content: "redelivered", operationId: "op-3" });
    await ingest({ type: "memory.added", content: "redelivered", operationId: "op-3" });

    expect(await archiveRows()).toHaveLength(1);
  });
});

describe("legacy runtime images", () => {
  it("an event with no operation id is left to the terminal path", async () => {
    // No id means the image predates the command route: the terminal aggregate
    // is its only writer, and applying here too would double it (the aggregate
    // carries no per-item identity to dedupe against).
    await ingest({ type: "memory.added", content: "legacy note" });

    expect(await archiveRows()).toHaveLength(0);

    // The terminal path then writes it exactly once.
    await addMemories(
      AGENT,
      ctx.defaultAppId,
      ctx.orgId,
      { type: "user", id: ctx.user.id },
      ["legacy note"],
      runId,
    );

    expect(await archiveRows()).toHaveLength(1);
  });
});

describe("dispatcher safety", () => {
  it("ignores memory events when no persistence context was supplied", async () => {
    // Callers that only want the write-through log (tests, legacy in-process
    // sink) must not accidentally gain a writer.
    await persistRunEvent(
      db,
      { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      runId,
      {
        runId,
        timestamp: Date.now(),
        type: "memory.added",
        content: "no context",
        operationId: "op-4",
      } as unknown as RunEvent,
      {},
    );

    expect(await archiveRows()).toHaveLength(0);
  });
});
