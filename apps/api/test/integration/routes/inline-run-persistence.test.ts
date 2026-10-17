// SPDX-License-Identifier: Apache-2.0

/**
 * An inline run may select the `note` / `pin` runtime tools, and finalisation
 * writes what they produce under the run's package id: the inline shadow
 * (`@inline/r-<uuid>`). The run detail page reads them back through
 * `GET /api/agents/:scope/:name/persistence?runId=`, so that read must serve a
 * shadow whose run lives in the caller's space, and only there.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedRun, seedSpace, seedSpaceMember } from "../../helpers/seed.ts";
import { insertShadowPackage } from "../../../src/services/inline-run.ts";
import { addMemories, upsertPinned } from "../../../src/services/state/package-persistence.ts";
import type { AgentManifest } from "../../../src/types/index.ts";

const app = getTestApp();

const shadowManifest = {
  name: "@inline/r-test",
  display_name: "Inline note taker",
  version: "0.0.0",
  type: "agent",
  description: "Inline",
  schema_version: "0.1",
  runtime_tools: ["note", "pin"],
} as unknown as AgentManifest;

interface PersistenceBody {
  object: string;
  memories?: Array<{ content: unknown; runId: string }>;
  pinned?: Array<{ key: string; content: unknown; runId: string }>;
}

describe("GET /api/agents/@inline/:name/persistence", () => {
  let ctx: TestContext;
  let shadowId: string;
  let runId: string;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "inlinepersist" });
    shadowId = await insertShadowPackage({
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      manifest: shadowManifest,
      prompt: "Take notes.",
    });
    const run = await seedRun({
      packageId: shadowId,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
      status: "success",
    });
    runId = run.id;
    const scope = { type: "user" as const, id: ctx.user.id };
    await addMemories(shadowId, ctx.defaultSpaceId, ctx.orgId, scope, ["inline-memo"], runId);
    await upsertPinned(shadowId, ctx.defaultSpaceId, ctx.orgId, scope, "todo", "inline-pin", runId);
  });

  it("serves the memories an inline run wrote, in the run's space", async () => {
    const res = await app.request(
      `/api/agents/${shadowId}/persistence?kind=memory&runId=${runId}`,
      { headers: authHeaders(ctx) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as PersistenceBody;
    expect(body.object).toBe("agent_persistence");
    expect(body.memories?.map((m) => m.content)).toEqual(["inline-memo"]);
    expect(body.memories?.[0]?.runId).toBe(runId);
  });

  it("serves the pinned slots an inline run wrote, in the run's space", async () => {
    const res = await app.request(
      `/api/agents/${shadowId}/persistence?kind=pinned&runId=${runId}`,
      { headers: authHeaders(ctx) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as PersistenceBody;
    expect(body.pinned?.map((p) => [p.key, p.content])).toEqual([["todo", "inline-pin"]]);
  });

  it("404s from another space of the same org, where the inline run does not live", async () => {
    const other = await seedSpace({ orgId: ctx.orgId, name: "Other" });
    await seedSpaceMember({ spaceId: other.id, userId: ctx.user.id, presetRole: "admin" });
    const res = await app.request(`/api/agents/${shadowId}/persistence?kind=memory`, {
      headers: authHeaders(ctx, { "X-Space-Id": other.id }),
    });
    expect(res.status).toBe(404);
  });

  it("404s from another organization", async () => {
    const stranger = await createTestContext({ orgSlug: "inlinepersist-other" });
    const res = await app.request(`/api/agents/${shadowId}/persistence?kind=memory`, {
      headers: authHeaders(stranger),
    });
    expect(res.status).toBe(404);
  });

  it("still serves an ordinary agent placed in this space", async () => {
    const agentId = "@inlinepersist/plain-agent";
    await seedAgent({ id: agentId, orgId: ctx.orgId, createdBy: ctx.user.id });
    const scope = { type: "user" as const, id: ctx.user.id };
    await addMemories(agentId, ctx.defaultSpaceId, ctx.orgId, scope, ["plain-memo"], null);
    const res = await app.request(`/api/agents/${agentId}/persistence?kind=memory`, {
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PersistenceBody;
    expect(body.memories?.map((m) => m.content)).toEqual(["plain-memo"]);
  });

  it("404s an inline shadow with no run in this space", async () => {
    const orphan = await insertShadowPackage({
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      manifest: shadowManifest,
      prompt: "Never run.",
    });
    const res = await app.request(`/api/agents/${orphan}/persistence?kind=memory`, {
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(404);
  });

  it("leaves every other agent route closed to the shadow", async () => {
    const detail = await app.request(`/api/agents/${shadowId}`, { headers: authHeaders(ctx) });
    expect(detail.status).toBe(404);
    const wipe = await app.request(`/api/agents/${shadowId}/persistence?kind=memory`, {
      method: "DELETE",
      headers: authHeaders(ctx),
    });
    expect(wipe.status).toBe(404);
  });
});
