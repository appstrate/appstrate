// SPDX-License-Identifier: Apache-2.0

/**
 * The container→platform write surface.
 *
 * These endpoints are reachable only with a run token from inside the sandbox,
 * and they are the only way an agent's memory changes. Two things are worth
 * testing at the route level rather than the service level: the auth boundary
 * (a run token is the ONLY credential, and only while the run is live), and the
 * app-wide write gate, whose whole purpose is to stop one agent rewriting state
 * every other actor reads.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { packages } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedRun } from "../../helpers/seed.ts";
import { signRunToken } from "../../../src/lib/run-token.ts";

const app = getTestApp();

describe("Internal persistence commands", () => {
  let ctx: TestContext;
  let pkgId: string;
  let runId: string;
  let token: string;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "cmdorg" });
    pkgId = "@cmdorg/test-agent";

    await seedAgent({ id: pkgId, orgId: ctx.orgId, createdBy: ctx.user.id });

    const run = await seedRun({
      packageId: pkgId,
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      userId: ctx.user.id,
      actorTypeSnapshot: "user",
      actorIdSnapshot: ctx.user.id,
      status: "running",
    });
    runId = run.id;
    token = signRunToken(runId);
  });

  function post(path: string, body: unknown, bearer: string | null = token) {
    return app.request(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  describe("auth boundary", () => {
    it("rejects an unauthenticated write", async () => {
      const res = await post("/internal/memory", { operation_id: "op", content: "x" }, null);
      expect(res.status).toBe(401);
    });

    it("rejects a forged token", async () => {
      const res = await post(
        "/internal/memory",
        { operation_id: "op", content: "x" },
        "not-a-real-token",
      );
      expect(res.status).toBe(401);
    });

    it("rejects a write once the run is no longer live", async () => {
      const finished = await seedRun({
        packageId: pkgId,
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        status: "success",
      });

      const res = await post(
        "/internal/memory",
        { operation_id: "op", content: "x" },
        signRunToken(finished.id),
      );
      expect(res.status).toBe(403);
    });
  });

  describe("POST /internal/memory", () => {
    it("commits and reports the outcome", async () => {
      const res = await post("/internal/memory", {
        operation_id: "op-1",
        content: "Gmail paginates at 100",
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ outcome: "committed" });
    });

    it("rejects a malformed body", async () => {
      const res = await post("/internal/memory", { content: "no operation id" });
      expect(res.status).toBe(400);
    });

    it("reports a refusal as a 200 outcome, not an HTTP error", async () => {
      // The agent has to be able to read the reason. An HTTP error would make
      // the runtime treat it as a transport fault and retry a write that can
      // never succeed.
      const res = await post("/internal/memory", {
        operation_id: "op-long",
        content: "x".repeat(2001),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { outcome: string; reason: string };
      expect(body.outcome).toBe("rejected");
      expect(body.reason).toBe("content_too_large");
    });
  });

  describe("POST /internal/slots", () => {
    it("returns the revision so the agent can edit conditionally later", async () => {
      const res = await post("/internal/slots", {
        operation_id: "op-slot",
        key: "goals",
        content: { a: 1 },
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ outcome: "committed", revision: 1 });
    });

    it("rejects a key the storage layer would refuse", async () => {
      const res = await post("/internal/slots", {
        operation_id: "op-bad",
        key: "Not A Valid Key",
        content: {},
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ outcome: "rejected", reason: "invalid_key" });
    });
  });

  describe("POST /internal/slots/update", () => {
    it("returns the current value on a stale revision", async () => {
      await post("/internal/slots", { operation_id: "s1", key: "state", content: { step: 1 } });
      await post("/internal/slots", { operation_id: "s2", key: "state", content: { step: 2 } });

      const res = await post("/internal/slots/update", {
        operation_id: "s3",
        key: "state",
        patch: { type: "merge", value: { step: 99 } },
        expected_revision: 1,
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        outcome: "conflict",
        revision: 2,
        current_content: { step: 2 },
      });
    });

    it("applies a merge patch and echoes the stored value", async () => {
      await post("/internal/slots", {
        operation_id: "s1",
        key: "state",
        content: { cursor: 1, label: "keep" },
      });

      const res = await post("/internal/slots/update", {
        operation_id: "s2",
        key: "state",
        patch: { type: "merge", value: { cursor: 2 } },
        expected_revision: 1,
      });

      // The resulting value comes back because the merge happened server-side —
      // the caller cannot otherwise know what the slot now holds.
      expect(await res.json()).toMatchObject({
        outcome: "committed",
        revision: 2,
        content: { cursor: 2, label: "keep" },
      });
    });

    it("rejects an unusable patch shape", async () => {
      const res = await post("/internal/slots/update", {
        operation_id: "s1",
        key: "state",
        patch: { type: "sprinkle", value: {} },
        expected_revision: 0,
      });

      expect(res.status).toBe(400);
    });
  });

  describe("app-wide writes are gated on the manifest capability", () => {
    /** Give the agent's draft manifest an explicit `memory.shared_writes`. */
    async function setSharedWrites(allowed: boolean) {
      const [row] = await db
        .select({ draftManifest: packages.draftManifest })
        .from(packages)
        .where(eq(packages.id, pkgId));
      await db
        .update(packages)
        .set({
          draftManifest: {
            ...((row!.draftManifest ?? {}) as Record<string, unknown>),
            memory: { shared_writes: allowed },
          },
        })
        .where(eq(packages.id, pkgId));
    }

    it("allows a shared write when the manifest declares it", async () => {
      await setSharedWrites(true);

      const res = await post("/internal/memory", {
        operation_id: "op-shared",
        content: "an app-wide fact",
        scope: "shared",
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ outcome: "committed" });
    });

    it("still allows an undeclared shared write while enforcement is off", async () => {
      // Warn-only by default: agents published before the capability existed
      // already write shared slots, and refusing them at deploy time would
      // break them with no migration path.
      const res = await post("/internal/memory", {
        operation_id: "op-undeclared",
        content: "legacy shared write",
        scope: "shared",
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ outcome: "committed" });
    });

    it("never gates an actor-scoped write", async () => {
      const res = await post("/internal/memory", {
        operation_id: "op-actor",
        content: "private note",
        scope: "actor",
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ outcome: "committed" });
    });
  });
});
