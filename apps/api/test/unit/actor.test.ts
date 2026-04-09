// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the Actor helper (getActor, actorInsert, actorFilter).
 */

import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../src/types/index.ts";
import { getActor, actorInsert, actorFilter } from "../../src/lib/actor.ts";
import { eq } from "drizzle-orm";
import type { Column } from "drizzle-orm";

// ---------------------------------------------------------------------------
// getActor
// ---------------------------------------------------------------------------

describe("getActor", () => {
  it("returns member actor when no endUser in context", async () => {
    const app = new Hono<AppEnv>();
    let actorType = "";
    let actorId = "";

    app.get("/test", (c) => {
      c.set("user", { id: "user-42", email: "u@test.com", name: "User" });
      const actor = getActor(c);
      actorType = actor.type;
      actorId = actor.id;
      return c.json({ ok: true });
    });

    await app.request("/test");
    expect(actorType).toBe("member");
    expect(actorId).toBe("user-42");
  });

  it("returns end_user actor when endUser is in context", async () => {
    const app = new Hono<AppEnv>();
    let actorType = "";
    let actorId = "";

    app.get("/test", (c) => {
      c.set("user", { id: "user-42", email: "u@test.com", name: "User" });
      c.set("endUser", {
        id: "eu_abc",
        applicationId: "app_default",
        name: "End User",
        email: "eu@test.com",
        role: "member",
      });
      const actor = getActor(c);
      actorType = actor.type;
      actorId = actor.id;
      return c.json({ ok: true });
    });

    await app.request("/test");
    expect(actorType).toBe("end_user");
    expect(actorId).toBe("eu_abc");
  });

  it("prefers end_user over member when both are set", async () => {
    const app = new Hono<AppEnv>();
    let actorType = "";
    let actorId = "";

    app.get("/test", (c) => {
      c.set("user", { id: "user-42", email: "u@test.com", name: "User" });
      c.set("endUser", {
        id: "eu_xyz",
        applicationId: "app_1",
        name: null,
        email: null,
        role: "member",
      });
      const actor = getActor(c);
      actorType = actor.type;
      actorId = actor.id;
      return c.json({ ok: true });
    });

    await app.request("/test");
    expect(actorType).toBe("end_user");
    expect(actorId).toBe("eu_xyz");
  });
});

// ---------------------------------------------------------------------------
// actorInsert
// ---------------------------------------------------------------------------

describe("actorInsert", () => {
  it("returns userId for member actor, endUserId null", () => {
    const result = actorInsert({ type: "member", id: "user-42" });
    expect(result).toEqual({
      userId: "user-42",
      endUserId: null,
    });
  });

  it("returns endUserId for end_user actor, userId null", () => {
    const result = actorInsert({ type: "end_user", id: "eu_abc" });
    expect(result).toEqual({
      userId: null,
      endUserId: "eu_abc",
    });
  });

  it("member actor sets userId to the actor id", () => {
    const result = actorInsert({ type: "member", id: "member-id-123" });
    expect(result.userId).toBe("member-id-123");
    expect(result.endUserId).toBeNull();
  });

  it("end_user actor sets endUserId to the actor id", () => {
    const result = actorInsert({ type: "end_user", id: "eu_end-user-id" });
    expect(result.endUserId).toBe("eu_end-user-id");
    expect(result.userId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// actorFilter
// ---------------------------------------------------------------------------

describe("actorFilter", () => {
  // Create mock columns to test the filter logic
  const mockCols = {
    userId: "userId" as unknown as Column,
    endUserId: "endUserId" as unknown as Column,
  };

  it("returns eq on userId column for member actor", () => {
    const result = actorFilter({ type: "member", id: "user-42" }, mockCols);
    const expected = eq(mockCols.userId, "user-42");
    // Verify the filter produces the same SQL structure
    expect(JSON.stringify(result)).toBe(JSON.stringify(expected));
  });

  it("returns eq on endUserId column for end_user actor", () => {
    const result = actorFilter({ type: "end_user", id: "eu_abc" }, mockCols);
    const expected = eq(mockCols.endUserId, "eu_abc");
    expect(JSON.stringify(result)).toBe(JSON.stringify(expected));
  });

  it("uses the correct actor id for member", () => {
    const result = actorFilter({ type: "member", id: "specific-id-123" }, mockCols);
    const expected = eq(mockCols.userId, "specific-id-123");
    expect(JSON.stringify(result)).toBe(JSON.stringify(expected));
  });

  it("uses the correct actor id for end_user", () => {
    const result = actorFilter({ type: "end_user", id: "eu_specific-id" }, mockCols);
    const expected = eq(mockCols.endUserId, "eu_specific-id");
    expect(JSON.stringify(result)).toBe(JSON.stringify(expected));
  });
});
