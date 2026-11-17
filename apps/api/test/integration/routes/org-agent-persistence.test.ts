// SPDX-License-Identifier: Apache-2.0

/**
 * `GET /api/orgs/{orgId}/agents/{scope}/{name}/persistence` — one agent's
 * memory in every space that reads the agent where the caller holds
 * `persistence:read`, each row naming its space. The actor partition is the
 * space route's, judged per space.
 *
 * The agent is homed in Un and placed in Deux; Trois holds rows but no
 * placement. Every space holds a shared row, the member's and the owner's.
 *
 * | caller         | Un (`persistence:read`) | Deux (`+ persistence:delete`) | Trois (not placed) |
 * | -------------- | ----------------------- | ----------------------------- | ------------------ |
 * | member session | own + shared            | every actor                   | nothing            |
 * | owner session  | every actor             | every actor                   | nothing            |
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, memberContext, type TestContext } from "../../helpers/auth.ts";
import {
  seedPackage,
  seedRun,
  seedSpace,
  seedSpaceGrant,
  seedSpacePackage,
} from "../../helpers/seed.ts";
import {
  addMemory,
  upsertPinned,
  type PersistenceScope,
} from "../../../src/services/state/package-persistence.ts";

const app = getTestApp();

const AGENT = "@orgpersist/agent";

interface Row {
  content: unknown;
  spaceId: string;
  actor_type: string;
  actor_id: string | null;
}

describe("GET /api/orgs/{orgId}/agents/{scope}/{name}/persistence", () => {
  let owner: TestContext;
  let member: TestContext;
  let s: Record<"un" | "deux" | "trois", string>;

  async function seedRows(spaceId: string, label: string) {
    const run = await seedRun({
      packageId: AGENT,
      orgId: owner.orgId,
      spaceId,
      userId: owner.user.id,
      status: "success",
    });
    const actors: Record<string, PersistenceScope> = {
      shared: { type: "shared" },
      member: { type: "user", id: member.user.id },
      owner: { type: "user", id: owner.user.id },
    };
    for (const [who, actor] of Object.entries(actors)) {
      await addMemory(AGENT, spaceId, owner.orgId, actor, `${label}:${who}`, run.id);
      await upsertPinned(
        AGENT,
        spaceId,
        owner.orgId,
        actor,
        `slot_${who}`,
        `${label}:${who}`,
        null,
      );
    }
  }

  beforeEach(async () => {
    await truncateAll();
    owner = await createTestContext({ orgSlug: "orgpersist" });
    member = await memberContext(owner, "member");
    const space = async (name: string) =>
      (await seedSpace({ orgId: owner.orgId, name, visibility: "closed" })).id;
    s = { un: await space("Un"), deux: await space("Deux"), trois: await space("Trois") };
    await seedPackage({
      id: AGENT,
      orgId: owner.orgId,
      homeSpaceId: s.un,
      createdBy: owner.user.id,
      draftManifest: { name: AGENT, version: "0.1.0", type: "agent" },
    });
    await seedSpacePackage(s.deux, AGENT);
    const join = (spaceId: string, permissions: string[]) =>
      seedSpaceGrant({ orgId: owner.orgId, spaceId, userId: member.user.id, permissions });
    await join(s.un, ["persistence:read"]);
    await join(s.deux, ["persistence:read", "persistence:delete"]);
    await join(s.trois, ["persistence:read", "persistence:delete"]);
    await seedRows(s.un, "un");
    await seedRows(s.deux, "deux");
    await seedRows(s.trois, "trois");
  });

  const path = (agent = AGENT, query = "") =>
    `/api/orgs/${owner.orgId}/agents/${agent}/persistence${query}`;

  async function read(headers: Record<string, string>, query = "") {
    const res = await app.request(path(AGENT, query), { headers });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as { object: string; pinned?: Row[]; memories?: Row[] };
    expect(body.object).toBe("agent_persistence");
    const contents = (rows: Row[] | undefined) =>
      rows === undefined ? undefined : rows.map((row) => String(row.content)).sort();
    return { body, pinned: contents(body.pinned), memories: contents(body.memories) };
  }

  it("lists each space's rows under its own actor partition, each naming its space", async () => {
    const { body, pinned, memories } = await read({ Cookie: member.cookie });
    const expected = ["un:member", "un:shared", "deux:member", "deux:owner", "deux:shared"].sort();
    expect(memories).toEqual(expected);
    expect(pinned).toEqual(expected);
    for (const row of [...body.pinned!, ...body.memories!]) {
      expect(row.spaceId).toBe(String(row.content).startsWith("un:") ? s.un : s.deux);
    }
  });

  it("serves every actor's rows where the caller holds persistence:delete", async () => {
    const { memories } = await read({ Cookie: owner.cookie });
    expect(memories).toEqual(
      ["un:member", "un:owner", "un:shared", "deux:member", "deux:owner", "deux:shared"].sort(),
    );
  });

  it("honours `kind` and an actor scope only where it may cross actors", async () => {
    const pinnedOnly = await read({ Cookie: member.cookie }, "?kind=pinned");
    expect(pinnedOnly.memories).toBeUndefined();
    expect(pinnedOnly.pinned).toHaveLength(5);

    const shared = await read({ Cookie: member.cookie }, "?kind=memory&actor_type=shared");
    // Deux narrows to the shared rows it was asked for; Un ignores the override.
    expect(shared.memories).toEqual(["deux:shared", "un:member", "un:shared"].sort());
  });

  it("answers 404 for an agent no granted space reads", async () => {
    const unknown = await app.request(path("@orgpersist/nope"), {
      headers: { Cookie: member.cookie },
    });
    expect(unknown.status).toBe(404);

    const elsewhere = "@orgpersist/elsewhere";
    const hidden = await seedSpace({ orgId: owner.orgId, name: "Caché", visibility: "closed" });
    await seedPackage({
      id: elsewhere,
      orgId: owner.orgId,
      homeSpaceId: hidden.id,
      createdBy: owner.user.id,
      draftManifest: { name: elsewhere, version: "0.1.0", type: "agent" },
    });
    const res = await app.request(path(elsewhere), { headers: { Cookie: member.cookie } });
    expect(res.status).toBe(404);
  });

  it("leaves the space route's rows without a space", async () => {
    const res = await app.request(`/api/agents/${AGENT}/persistence?kind=memory`, {
      headers: { Cookie: member.cookie, "X-Org-Id": owner.orgId, "X-Space-Id": s.deux },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { memories: Array<Record<string, unknown>> };
    expect(body.memories).toHaveLength(3);
    expect(body.memories.every((row) => !("spaceId" in row))).toBe(true);
  });
});
