// SPDX-License-Identifier: Apache-2.0

/**
 * Chat sessions are space-scoped (RBAC spec §5).
 *
 * `(org_id, space_id, user_id)` is the ownership triple every read filters on,
 * so the same user in another space sees another conversation list.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../../apps/api/test/helpers/app.ts";
import { truncateAll } from "../../../apps/api/test/helpers/db.ts";
import {
  createTestContext,
  authHeaders,
  orgOnlyHeaders,
  type TestContext,
} from "../../../apps/api/test/helpers/auth.ts";
import { internalDispatchHeader } from "../../../apps/api/src/lib/internal-dispatch.ts";
import { seedSpace } from "../../../apps/api/test/helpers/seed.ts";

const app = getTestApp();

describe("chat sessions are space-scoped", () => {
  let ctx: TestContext;
  let otherSpaceId: string;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "chatspaces" });
    otherSpaceId = (await seedSpace({ orgId: ctx.orgId, name: "Space B" })).id;
  });

  async function createSession(spaceId: string): Promise<string> {
    const res = await app.request("/api/chat/sessions", {
      method: "POST",
      headers: {
        ...authHeaders(ctx, { "X-Space-Id": spaceId }),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  async function listSessions(spaceId: string): Promise<Response> {
    return app.request("/api/chat/sessions", {
      headers: authHeaders(ctx, { "X-Space-Id": spaceId }),
    });
  }

  it("a session created in space A is not listed from space B", async () => {
    const inA = await createSession(ctx.defaultSpaceId);
    const inB = await createSession(otherSpaceId);

    const fromA = (await (await listSessions(ctx.defaultSpaceId)).json()) as {
      data: { id: string }[];
    };
    const fromB = (await (await listSessions(otherSpaceId)).json()) as { data: { id: string }[] };

    expect(fromA.data.map((s) => s.id)).toEqual([inA]);
    expect(fromB.data.map((s) => s.id)).toEqual([inB]);
  });

  it("a session of space A is a 404 when read, renamed or deleted from space B", async () => {
    const inA = await createSession(ctx.defaultSpaceId);
    const fromB = (path: string, init?: RequestInit) =>
      app.request(path, {
        ...init,
        headers: {
          ...authHeaders(ctx, { "X-Space-Id": otherSpaceId }),
          "Content-Type": "application/json",
        },
      });

    expect((await fromB(`/api/chat/sessions/${inA}`)).status).toBe(404);
    expect(
      (
        await fromB(`/api/chat/sessions/${inA}`, {
          method: "PATCH",
          body: JSON.stringify({ title: "Stolen" }),
        })
      ).status,
    ).toBe(404);
    expect((await fromB(`/api/chat/sessions/${inA}`, { method: "DELETE" })).status).toBe(404);

    // The control: the same three calls from the session's own space.
    const fromA = (path: string, init?: RequestInit) =>
      app.request(path, {
        ...init,
        headers: {
          ...authHeaders(ctx, { "X-Space-Id": ctx.defaultSpaceId }),
          "Content-Type": "application/json",
        },
      });
    expect((await fromA(`/api/chat/sessions/${inA}`)).status).toBe(200);
    expect(
      (
        await fromA(`/api/chat/sessions/${inA}`, {
          method: "PATCH",
          body: JSON.stringify({ title: "Mine" }),
        })
      ).status,
    ).toBe(204);
    expect((await fromA(`/api/chat/sessions/${inA}`, { method: "DELETE" })).status).toBe(204);
  });
});

/**
 * `/api/chat/*` enters a space UNCONDITIONALLY (every chat resource is
 * space-level), so it is where the `enterSpaceContext` seam's refusal is
 * observable end to end: a module route is not a weaker door than a core one.
 */
describe("the enterSpaceContext seam on /api/chat", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "chatseam" });
  });

  it("400s a session caller that names no space, and 200s the same call with the header", async () => {
    const without = await app.request("/api/chat/sessions", { headers: orgOnlyHeaders(ctx) });
    expect(without.status).toBe(400);
    const body = (await without.json()) as { code: string; detail: string; param?: string };
    expect(body.code).toBe("invalid_request");
    expect(body.param).toBe("X-Space-Id");
    expect(body.detail).toContain("Space context required");

    expect((await app.request("/api/chat/sessions", { headers: authHeaders(ctx) })).status).toBe(
      200,
    );
  });

  it("still lands the trusted in-process dispatch on the org default space", async () => {
    // The one caller that physically cannot carry a header. Its exemption is
    // what the 400 above must NOT have taken away.
    const res = await app.request("/api/chat/sessions", {
      headers: { ...orgOnlyHeaders(ctx), ...Object.fromEntries([internalDispatchHeader()]) },
    });
    expect(res.status).toBe(200);
  });
});
