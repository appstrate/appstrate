// SPDX-License-Identifier: Apache-2.0

/**
 * `X-Space-Id` shape enforcement, end to end.
 *
 * The unit tests in `test/unit/lib/ids.test.ts` pin `assertSpaceId` itself.
 * These pin that a request actually reaches it, and reaches it BEFORE the
 * `spaces` lookup — a wrong-shaped id must be answered with a 400, not a 404
 * ("no such space", which reads like a client mistake about a well-formed id).
 *
 * `spc_`-prefixed-but-malformed ids are covered here too: they are the cases
 * that discriminate the strict regex from the `/^spc_.+/` widening its
 * docblock forbids.
 */

import { describe, it, expect, beforeEach, spyOn } from "bun:test";
import { Hono } from "hono";
import { db } from "@appstrate/db/client";
import type { AppEnv } from "../../../src/types/index.ts";
import { requireSpaceContext } from "../../../src/middleware/space-context.ts";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import {
  createTestContext,
  authHeaders,
  memberContext,
  type TestContext,
} from "../../helpers/auth.ts";
import { seedApiKey, seedSpace, seedSpaceMember } from "../../helpers/seed.ts";
import { prefixedId } from "@appstrate/db/ids";

const app = getTestApp();

/** A retired-prefix id whose UUID half is perfectly well-formed. */
const WRONG_PREFIX_ID = "app_2f1c6d84-9a52-4f2b-b1a7-0c9d3e5f7a10";

/**
 * `spc_`-prefixed ids the strict regex rejects and `/^spc_.+/` would accept.
 * A canonical id of the same org would 200; these must 400 on shape.
 */
const MALFORMED_SPC_IDS = [
  "spc_1",
  "spc_2f1c6d849a524f2bb1a70c9d3e5f7a10",
  "spc_2F1C6D84-9A52-4F2B-B1A7-0C9D3E5F7A10",
  "spc_2f1c6d84-9a52-4f2b-0c9d3e5f7a10",
];

describe("space-context middleware — X-Space-Id shape", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "testorg" });
  });

  it("accepts the org's canonical space id", async () => {
    const res = await app.request("/api/agents", { headers: authHeaders(ctx) });
    expect(res.status).toBe(200);
  });

  it("400s a wrong-prefix id on shape — not a 404 from the spaces lookup", async () => {
    const res = await app.request("/api/agents", {
      headers: authHeaders(ctx, { "X-Space-Id": WRONG_PREFIX_ID }),
    });

    // 404 would be the answer for a well-formed id that does not exist. This
    // one never reaches the lookup: the shape guard answers first.
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; detail: string; param?: string };
    expect(body.code).toBe("invalid_request");
    expect(body.param).toBe("space_id");
    expect(body.detail).toContain("Malformed");
    // No rename, no migration: the platform does not recognise `app_` at all.
    expect(body.detail).not.toContain("retired");
    expect(body.detail).not.toContain("migration");
  });

  for (const id of MALFORMED_SPC_IDS) {
    it(`400s the malformed space id '${id}'`, async () => {
      const res = await app.request("/api/agents", {
        headers: authHeaders(ctx, { "X-Space-Id": id }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string; detail: string };
      expect(body.code).toBe("invalid_request");
      expect(body.detail).toContain("Malformed space id");
      expect(body.detail).toContain("canonical UUID");
      // Not the migration diagnostic — the prefix is current, the id is junk.
      expect(body.detail).not.toContain("retired");
    });
  }

  it("404s a canonical id that belongs to no space in this org", async () => {
    const res = await app.request("/api/agents", {
      headers: authHeaders(ctx, { "X-Space-Id": prefixedId("spc") }),
    });
    expect(res.status).toBe(404);
  });
});

/**
 * Entering a space by id is ONE read (`enterSpaceById`): the caller's
 * membership snapshot doubles as the space∈org lookup. These pin that the
 * collapse kept every refusal, on both admission paths — the caller's own role
 * (that one read) and a role preview, judged on the persona (the org-scoped
 * lookup): a space of another org, one that does not exist and a private one
 * the caller is not in all answer the SAME 404 body — so the answer never
 * confirms that an id exists — and a closed space the caller holds no role in
 * is the 403, until a role lets it in.
 */
describe("space-context middleware — entering a space by id", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "testorg" });
  });

  const readAgents = async (as: TestContext, spaceId: string, viewAs?: string) =>
    app.request("/api/agents", {
      headers: authHeaders(as, {
        "X-Space-Id": spaceId,
        ...(viewAs ? { "X-View-As": viewAs } : {}),
      }),
    });

  /** The refusal matrix through `enter`; `seatedIn(id)` enters `id` holding a role there. */
  async function expectEntryRefusals(
    enter: (spaceId: string) => Promise<Response>,
    seatedIn: (spaceId: string) => Promise<Response>,
  ) {
    const other = await createTestContext({ orgSlug: "otherorg" });
    const foreign = await seedSpace({ orgId: other.orgId, visibility: "open" });
    const priv = await seedSpace({ orgId: ctx.orgId, visibility: "private" });
    const closed = await seedSpace({ orgId: ctx.orgId, visibility: "closed" });

    const codes = new Set<string>();
    for (const id of [prefixedId("spc"), foreign.id, priv.id]) {
      const res = await enter(id);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { code: string; detail: string };
      expect(body.detail).toBe(`Space '${id}' not found in this organization`);
      codes.add(body.code);
    }
    expect(codes.size).toBe(1);

    const refused = await enter(closed.id);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({
      code: "not_a_space_member",
      detail: `You are not a member of space '${closed.id}'`,
    });
    expect((await seatedIn(closed.id)).status).toBe(200);
    return { other, foreign };
  }

  it("judges a caller on its own role", async () => {
    const member = await memberContext(ctx, "member");
    const { other, foreign } = await expectEntryRefusals(
      (id) => readAgents(member, id),
      async (id) => {
        await seedSpaceMember({ spaceId: id, userId: member.user.id, presetRole: "viewer" });
        return readAgents(member, id);
      },
    );
    // Even the owner is refused another org's space, which that org's owner
    // reaches: the refusal is the org boundary.
    expect((await readAgents(ctx, foreign.id)).status).toBe(404);
    expect((await readAgents(other, foreign.id)).status).toBe(200);
  });

  it("judges a role preview on the persona, not on the owner's reach", async () => {
    await expectEntryRefusals(
      (id) => readAgents(ctx, id, "org_role=member"),
      // The persona's own row is what lets it in.
      (id) => readAgents(ctx, id, `org_role=member; space=${id}; role=preset:viewer`),
    );
  });

  it("holds a space-pinned API key to its space", async () => {
    const sibling = await seedSpace({ orgId: ctx.orgId, visibility: "open" });
    const key = await seedApiKey({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      createdBy: ctx.user.id,
      scopes: ["agents:read"],
    });
    const bearer = { Authorization: `Bearer ${key.rawKey}` };

    expect((await app.request("/api/agents", { headers: bearer })).status).toBe(200);
    const spoofed = await app.request("/api/agents", {
      headers: { ...bearer, "X-Space-Id": sibling.id },
    });
    expect(spoofed.status).toBe(403);
    expect(((await spoofed.json()) as { detail: string }).detail).toBe(
      "X-Space-Id does not match authenticated space",
    );
  });
});

/**
 * The read count itself, on the middleware alone: an org member naming a space
 * by id costs ONE `SELECT` — the membership snapshot, filtered on `(id, orgId)`
 * — where it used to cost a lookup and then that snapshot. A caller whose
 * admission reads no membership (an end-user token, no org role) keeps the one
 * lookup it always had.
 */
describe("space-context middleware — one read to enter a space by id", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "testorg" });
  });

  /** `requireSpaceContext` behind a stub that plays the auth pipeline, counting `db.select`. */
  async function selectsToEnter(as: { orgRole?: "owner"; principalKind: "user" | "end_user" }) {
    const probe = new Hono<AppEnv>();
    probe.use("*", async (c, next) => {
      c.set("user", { id: ctx.user.id, email: "", name: "" });
      c.set("orgId", ctx.orgId);
      if (as.orgRole) c.set("orgRole", as.orgRole);
      c.set("principalKind", as.principalKind);
      c.set("orgPermissions", new Set());
      return next();
    });
    probe.get("/", requireSpaceContext(), (c) => c.json({ space: c.get("space")?.id }));
    probe.onError((err, c) => c.json({ error: err.message }, 500));
    const selects = spyOn(db, "select");
    try {
      const res = await probe.request("/", { headers: { "X-Space-Id": ctx.defaultSpaceId } });
      return { status: res.status, selects: selects.mock.calls.length };
    } finally {
      selects.mockRestore();
    }
  }

  it("reads the space once, with an org role and for an end-user token alike", async () => {
    const once = { status: 200, selects: 1 };
    expect(await selectsToEnter({ orgRole: "owner", principalKind: "user" })).toEqual(once);
    expect(await selectsToEnter({ principalKind: "end_user" })).toEqual(once);
  });
});
