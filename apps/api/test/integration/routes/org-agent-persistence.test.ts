// SPDX-License-Identifier: Apache-2.0

/**
 * `GET /api/orgs/{orgId}/agents/{scope}/{name}/persistence` — one agent's
 * memory in every space that reads the agent where the caller holds
 * `persistence:read`, each row naming its space. The actor partition is the
 * space route's, judged per space.
 *
 * The agent is homed in Un and placed in Deux and Quatre; Trois holds rows but
 * no placement. Every space holds a shared row, the member's and the owner's.
 *
 * | caller                                   | Un (`persistence:read`) | Deux (`+ persistence:delete`) | Trois (not placed) | Quatre (`agents:read` only) |
 * | ---------------------------------------- | ----------------------- | ----------------------------- | ------------------ | --------------------------- |
 * | member session                           | own + shared            | every actor                   | nothing            | nothing                     |
 * | owner session                            | every actor             | every actor                   | nothing            | every actor                 |
 * | member loopback bearer, `persistence:read` ceiling | own + shared  | own + shared                  | nothing            | nothing                     |
 *
 * A role preview reads with the persona's actor partition. The reach every org
 * read shares (pinned key, ceiling, end-user, …) is in `cross-space-reads.test.ts`.
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
import { memberLoopbackHeaders } from "../../helpers/loopback.ts";
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
  let s: Record<"un" | "deux" | "trois" | "quatre", string>;
  /** The run of each space's memories, by space. */
  let runOf: Record<string, string>;

  async function seedRows(spaceId: string, label: string) {
    const run = await seedRun({
      packageId: AGENT,
      orgId: owner.orgId,
      spaceId,
      userId: owner.user.id,
      status: "success",
    });
    runOf[spaceId] = run.id;
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
    s = {
      un: await space("Un"),
      deux: await space("Deux"),
      trois: await space("Trois"),
      quatre: await space("Quatre"),
    };
    runOf = {};
    await seedPackage({
      id: AGENT,
      orgId: owner.orgId,
      homeSpaceId: s.un,
      createdBy: owner.user.id,
      draftManifest: { name: AGENT, version: "0.1.0", type: "agent" },
    });
    await seedSpacePackage(s.deux, AGENT);
    await seedSpacePackage(s.quatre, AGENT);
    const join = (spaceId: string, permissions: string[]) =>
      seedSpaceGrant({ orgId: owner.orgId, spaceId, userId: member.user.id, permissions });
    await join(s.un, ["persistence:read"]);
    await join(s.deux, ["persistence:read", "persistence:delete"]);
    await join(s.trois, ["persistence:read", "persistence:delete"]);
    await join(s.quatre, ["agents:read"]);
    await seedRows(s.un, "un");
    await seedRows(s.deux, "deux");
    await seedRows(s.trois, "trois");
    await seedRows(s.quatre, "quatre");
  });

  const everyActor = (label: string) =>
    ["member", "owner", "shared"].map((who) => `${label}:${who}`);
  const ownAndShared = (label: string) => [`${label}:member`, `${label}:shared`];

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
    expect(memories).toEqual(["un", "deux", "quatre"].flatMap((label) => everyActor(label)).sort());
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

  it("names each row's space on the space route too", async () => {
    const res = await app.request(`/api/agents/${AGENT}/persistence`, {
      headers: { Cookie: member.cookie, "X-Org-Id": owner.orgId, "X-Space-Id": s.deux },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pinned: Row[]; memories: Row[] };
    expect(body.memories).toHaveLength(3);
    expect([...body.pinned, ...body.memories].every((row) => row.spaceId === s.deux)).toBe(true);
  });

  it("refuses an unknown parameter and a value outside a closed set, on both doors", async () => {
    const spaceHeaders = { Cookie: member.cookie, "X-Org-Id": owner.orgId, "X-Space-Id": s.deux };
    for (const query of ["?bogus=1", "?kind=all", "?actor_type=robot"]) {
      const org = await app.request(path(AGENT, query), { headers: { Cookie: member.cookie } });
      expect(org.status, query).toBe(400);
      const space = await app.request(`/api/agents/${AGENT}/persistence${query}`, {
        headers: spaceHeaders,
      });
      expect(space.status, query).toBe(400);
    }
    // The bulk delete reads the same filters, without `runId`; a refused query deletes nothing.
    for (const query of ["?bogus=1", "?kind=all", `?runId=${runOf[s.deux]}`]) {
      const removed = await app.request(`/api/agents/${AGENT}/persistence${query}`, {
        method: "DELETE",
        headers: spaceHeaders,
      });
      expect(removed.status, query).toBe(400);
    }
    expect((await read({ Cookie: member.cookie })).memories.length).toBeGreaterThan(0);
  });

  it("narrows to one run's rows with runId", async () => {
    const { memories, pinned } = await read({ Cookie: member.cookie }, `?runId=${runOf[s.deux]}`);
    expect(memories).toEqual(everyActor("deux").sort());
    // The slots were written with no run.
    expect(pinned).toEqual([]);
  });

  it("merges the spaces' rows in one order: pinned newest update first, memories oldest first", async () => {
    await Bun.sleep(5);
    await addMemory(AGENT, s.un, owner.orgId, { type: "shared" }, "un:latest", runOf[s.un]!);
    await upsertPinned(
      AGENT,
      s.un,
      owner.orgId,
      { type: "shared" },
      "slot_latest",
      "un:latest",
      null,
    );
    const { body } = await read({ Cookie: member.cookie });
    expect(String(body.memories!.at(-1)!.content)).toBe("un:latest");
    expect(String(body.pinned![0]!.content)).toBe("un:latest");
    // Without the merge, Un's rows would come together, before or after Deux's.
    const spaces = body.memories!.map((row) => row.spaceId);
    expect(spaces.indexOf(s.deux)).toBeLessThan(spaces.lastIndexOf(s.un));
  });

  describe("credentials", () => {
    it("reads a delegated bearer without persistence:delete in its own actor partition", async () => {
      const { memories } = await read(
        memberLoopbackHeaders(member, owner.orgId, ["persistence:read"]),
      );
      // The member holds `persistence:delete` in Deux; the bearer's ceiling does not.
      expect(memories).toEqual([...ownAndShared("un"), ...ownAndShared("deux")].sort());
    });

    it("reads a role preview with the persona's actor partition", async () => {
      // The default space is open: its default role reads persistence, deletes none.
      await seedSpacePackage(owner.defaultSpaceId, AGENT);
      await seedRows(owner.defaultSpaceId, "default");
      const asOwner = await read({ Cookie: owner.cookie });
      expect(asOwner.memories).toEqual(expect.arrayContaining(everyActor("default")));
      const previewed = await read({ Cookie: owner.cookie, "X-View-As": "org_role=member" });
      expect(previewed.memories).toEqual(["default:owner", "default:shared"]);
    });
  });
});
