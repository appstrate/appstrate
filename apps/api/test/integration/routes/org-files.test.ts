// SPDX-License-Identifier: Apache-2.0

/**
 * `GET /api/orgs/{orgId}/files` — the file gallery of every space where the
 * caller holds `files:read`, each row decided by the caller's role in ITS space.
 *
 * Spaces of the member (custom roles unless stated):
 *   Un    `files:read` + `runs:read-all` + `files:delete`
 *   Deux  `files:read` only
 *   Trois `files:read` + `runs:read-all` (no `files:delete`)
 *   Quatre `runs:read-all` only (no `files:read`)
 *   Default open space, implicit `operator` (`files:read`, `runs:read`)
 *   Fermé `closed`, not joined; Privé `private`, not a member
 *
 * | credential                                   | space / rule                                   | rows, fields                                              |
 * | -------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------- |
 * | member session                               | Un (read-all)                                  | every run file, the detached deliverable, own rows        |
 * | member session                               | Un — owner's chat attachment                   | never: a conversation is its owner's, whatever the grant  |
 * | member session                               | Un — owner's run upload                        | listed, opaque (`name: file`, not downloadable)           |
 * | member session                               | Un (`files:delete`)                            | `capabilities.delete` on the owner's rows                 |
 * | member session                               | Trois (read-all, no `files:delete`)            | the owner's run file, `capabilities.delete` false         |
 * | member session                               | Deux / Default (no read-all)                   | own rows only                                             |
 * | member session                               | Quatre (no `files:read`)                       | none, own rows included                                   |
 * | member session                               | Fermé / Privé                                  | none                                                      |
 * | member session                               | `runId` of a run in Fermé whose input names an own file | that file is NOT added: the run is looked up in the listed spaces only |
 * | member session                               | `context_chat_session_id` of own session (Deux) | its attachment                                           |
 * | member session                               | `startingAfter` + `limit`                      | one keyset order across spaces                            |
 * | owner session                                | every team space (preset `admin`)              | every row                                                 |
 * | API key pinned to Un, scopes `files:read` + `runs:read-all` | Un only, ceiling applied        | every Un row, `capabilities.delete` false                 |
 * | chat loopback bearer (user, ceiling)         | the session's reach, capped by the ceiling     | ceiling `files:read` → own rows only                      |
 *
 * The reach every list shares is in `cross-space-reads.test.ts`; the MCP door
 * in `modules/mcp/test/integration/org-reads.test.ts`.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { db } from "@appstrate/db/client";
import { chatSessions, files } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import {
  addOrgMember,
  createTestContext,
  memberContext,
  type TestContext,
} from "../../helpers/auth.ts";
import { seedApiKey, seedPackage, seedRun, seedSpace, seedSpaceGrant } from "../../helpers/seed.ts";
import { mintMcpLoopbackToken } from "../../../../../packages/module-chat/src/loopback-auth.ts";

const app = getTestApp();

interface ListedFile {
  id: string;
  spaceId: string;
  name: string;
  downloadable: boolean;
  capabilities: { delete: boolean };
}
interface FilePage {
  object: string;
  data: ListedFile[];
  hasMore: boolean;
  limit: number;
}

describe("GET /api/orgs/{orgId}/files", () => {
  let owner: TestContext;
  let member: TestContext;
  let s: Record<"un" | "deux" | "trois" | "quatre" | "ferme" | "prive", string>;
  /** File ids by name. */
  let f: Record<string, string>;
  let ownerChatSession: string;
  let memberChatSession: string;
  let fermeRunNamingOwnFile: string;
  let clock: number;

  async function seedSpaceRun(spaceId: string, userId: string, input?: Record<string, unknown>) {
    const pkg = await seedPackage({
      id: `@orgfiles/agent-${crypto.randomUUID().slice(0, 8)}`,
      orgId: owner.orgId,
      homeSpaceId: spaceId,
      createdBy: userId,
    });
    const run = await seedRun({
      packageId: pkg.id,
      orgId: owner.orgId,
      spaceId,
      userId,
      status: "success",
      input: input ?? null,
      startedAt: new Date(),
    });
    return run.id;
  }

  /** A file row (no bytes: the list reads rows), each one second newer than the last. */
  async function seedFile(
    spaceId: string,
    userId: string,
    container: { runId?: string; chatSessionId?: string } = {},
    purpose: "agent_output" | "user_upload" = "agent_output",
    orgId = owner.orgId,
  ) {
    const id = `file_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
    await db.insert(files).values({
      id,
      orgId,
      spaceId,
      purpose,
      runId: container.runId ?? null,
      chatSessionId: container.chatSessionId ?? null,
      userId,
      storageKey: `files/${spaceId}/${id}/real-name.txt`,
      name: "real-name.txt",
      mime: "text/plain",
      size: 4,
      sha256: "0".repeat(64),
      createdAt: new Date(clock++ * 1000),
    });
    return id;
  }

  async function seedChatSession(spaceId: string, userId: string) {
    const id = `chs_${crypto.randomUUID()}`;
    await db.insert(chatSessions).values({ id, orgId: owner.orgId, spaceId, userId });
    return id;
  }

  beforeEach(async () => {
    await truncateAll();
    clock = 1_700_000_000;
    owner = await createTestContext({ orgSlug: "orgfiles" });
    member = await memberContext(owner, "member");
    const space = async (name: string, visibility: "closed" | "private" = "closed") =>
      (await seedSpace({ orgId: owner.orgId, name, visibility })).id;
    s = {
      un: await space("Un"),
      deux: await space("Deux"),
      trois: await space("Trois"),
      quatre: await space("Quatre"),
      ferme: await space("Fermé"),
      prive: await space("Privé", "private"),
    };
    const join = (spaceId: string, permissions: string[]) =>
      seedSpaceGrant({ orgId: owner.orgId, spaceId, userId: member.user.id, permissions });
    await join(s.un, ["files:read", "runs:read-all", "files:delete"]);
    await join(s.deux, ["files:read"]);
    await join(s.trois, ["files:read", "runs:read-all"]);
    await join(s.quatre, ["runs:read-all"]);

    const dflt = owner.defaultSpaceId;
    const runs = {
      unOwner: await seedSpaceRun(s.un, owner.user.id),
      unMember: await seedSpaceRun(s.un, member.user.id),
      deuxOwner: await seedSpaceRun(s.deux, owner.user.id),
      deuxMember: await seedSpaceRun(s.deux, member.user.id),
      troisOwner: await seedSpaceRun(s.trois, owner.user.id),
      quatreOwner: await seedSpaceRun(s.quatre, owner.user.id),
      quatreMember: await seedSpaceRun(s.quatre, member.user.id),
      defaultOwner: await seedSpaceRun(dflt, owner.user.id),
      defaultMember: await seedSpaceRun(dflt, member.user.id),
      ferme: await seedSpaceRun(s.ferme, owner.user.id),
      prive: await seedSpaceRun(s.prive, owner.user.id),
    };
    ownerChatSession = await seedChatSession(s.un, owner.user.id);
    memberChatSession = await seedChatSession(s.deux, member.user.id);
    f = {
      unOwnerOutput: await seedFile(s.un, owner.user.id, { runId: runs.unOwner }),
      unOwnerUpload: await seedFile(s.un, owner.user.id, { runId: runs.unOwner }, "user_upload"),
      unMemberOutput: await seedFile(s.un, member.user.id, { runId: runs.unMember }),
      unDetached: await seedFile(s.un, owner.user.id),
      unOwnerChat: await seedFile(s.un, owner.user.id, { chatSessionId: ownerChatSession }),
      deuxOwnerOutput: await seedFile(s.deux, owner.user.id, { runId: runs.deuxOwner }),
      deuxMemberOutput: await seedFile(s.deux, member.user.id, { runId: runs.deuxMember }),
      deuxMemberChat: await seedFile(s.deux, member.user.id, { chatSessionId: memberChatSession }),
      troisOwnerOutput: await seedFile(s.trois, owner.user.id, { runId: runs.troisOwner }),
      quatreOwnerOutput: await seedFile(s.quatre, owner.user.id, { runId: runs.quatreOwner }),
      quatreMemberOutput: await seedFile(s.quatre, member.user.id, { runId: runs.quatreMember }),
      defaultOwnerOutput: await seedFile(dflt, owner.user.id, { runId: runs.defaultOwner }),
      defaultMemberOutput: await seedFile(dflt, member.user.id, { runId: runs.defaultMember }),
      fermeOutput: await seedFile(s.ferme, owner.user.id, { runId: runs.ferme }),
      priveOutput: await seedFile(s.prive, owner.user.id, { runId: runs.prive }),
    };
    // A run of Fermé (unreached) whose input names one of the member's own files.
    fermeRunNamingOwnFile = await seedSpaceRun(s.ferme, owner.user.id, {
      doc: `appfile://${f.defaultMemberOutput}`,
    });

    const foreign = await createTestContext({ orgSlug: "orgfiles-foreign" });
    await addOrgMember(foreign.orgId, member.user.id, "member");
    await seedFile(foreign.defaultSpaceId, member.user.id, {}, "agent_output", foreign.orgId);
  });

  const path = (query = "") => `/api/orgs/${owner.orgId}/files${query}`;
  const session = (ctx: TestContext, extra: Record<string, string> = {}) => ({
    Cookie: ctx.cookie,
    ...extra,
  });

  async function list(headers: Record<string, string>, query = ""): Promise<FilePage> {
    const res = await app.request(path(query), { headers });
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as FilePage;
  }
  const ids = (page: FilePage) => page.data.map((file) => file.id).sort();
  const pick = (...names: string[]) => names.map((name) => f[name]!).sort();
  /** What the member reads with its session, everywhere. */
  const memberRows = [
    "unOwnerOutput",
    "unOwnerUpload",
    "unMemberOutput",
    "unDetached",
    "deuxMemberOutput",
    "deuxMemberChat",
    "troisOwnerOutput",
    "defaultMemberOutput",
  ];

  it("serves each space what the member's role there grants, and nothing of the others", async () => {
    const page = await list(session(member), "?limit=100");
    expect(ids(page)).toEqual(pick(...memberRows));
    expect(page.hasMore).toBe(false);
    const byId = new Map(page.data.map((file) => [file.id, file]));
    expect(byId.get(f.unOwnerOutput!)!.spaceId).toBe(s.un);
    expect(byId.get(f.troisOwnerOutput!)!.spaceId).toBe(s.trois);
  });

  it("decides the capabilities per row, by the row's space", async () => {
    const byId = new Map(
      (await list(session(member), "?limit=100")).data.map((file) => [file.id, file]),
    );
    // `files:delete` in Un, not in Trois: one page, two answers on the owner's rows.
    expect(byId.get(f.unOwnerOutput!)!.capabilities.delete).toBe(true);
    expect(byId.get(f.troisOwnerOutput!)!.capabilities.delete).toBe(false);
    // The creator keeps its own lifecycle wherever it reads (a session is unbounded).
    expect(byId.get(f.deuxMemberOutput!)!.capabilities.delete).toBe(true);
    // Another member's upload stays opaque to a supervising reader.
    const upload = byId.get(f.unOwnerUpload!)!;
    expect(upload.name).toBe("file");
    expect(upload.downloadable).toBe(false);
    expect(byId.get(f.unOwnerOutput!)!.name).toBe("real-name.txt");
  });

  it("pages across spaces with one keyset order", async () => {
    const seen: string[] = [];
    let cursor = "";
    for (;;) {
      const page = await list(session(member), `?limit=3${cursor}`);
      seen.push(...page.data.map((file) => file.id));
      if (!page.hasMore) break;
      cursor = `&startingAfter=${page.data.at(-1)!.id}`;
    }
    expect(seen).toHaveLength(memberRows.length);
    expect([...seen].sort()).toEqual(pick(...memberRows));
    // Newest first, whatever the space.
    const order = Object.values(f);
    expect(seen).toEqual([...seen].sort((a, b) => order.indexOf(b) - order.indexOf(a)));
  });

  it("composes the filters of GET /api/files", async () => {
    expect(ids(await list(session(member), "?purpose=user_upload"))).toEqual(pick("unOwnerUpload"));
    expect(
      ids(await list(session(member), `?context_chat_session_id=${memberChatSession}`)),
    ).toEqual(pick("deuxMemberChat"));
    expect(
      ids(await list(session(member), `?context_chat_session_id=${ownerChatSession}`)),
    ).toEqual([]);
  });

  it("looks a runId up in the listed spaces only", async () => {
    // Fermé is not reached: its run's input refs never widen the page.
    expect(ids(await list(session(member), `?runId=${fermeRunNamingOwnFile}`))).toEqual([]);
    // The owner reaches Fermé: the consumed file joins the run's.
    expect(ids(await list(session(owner), `?runId=${fermeRunNamingOwnFile}`))).toEqual(
      pick("defaultMemberOutput"),
    );
  });

  it("serves the owner every row of every team space, private included", async () => {
    const page = await list(session(owner), "?limit=100");
    // The member's chat attachment is the member's conversation, not the owner's.
    const everyRow = Object.keys(f).filter((name) => name !== "deuxMemberChat");
    expect(ids(page)).toEqual(pick(...everyRow));
  });

  it("caps a space-pinned API key's rows and capabilities with its scopes", async () => {
    const key = await seedApiKey({
      orgId: owner.orgId,
      spaceId: s.un,
      createdBy: owner.user.id,
      scopes: ["files:read", "runs:read-all"],
    });
    const headers = { Authorization: `Bearer ${key.rawKey}` };
    const page = await list(headers);
    expect(ids(page)).toEqual(
      pick("unOwnerOutput", "unOwnerUpload", "unMemberOutput", "unDetached", "unOwnerChat"),
    );
    // No `files:delete` in its scopes: no lifecycle, not even on the creator's rows.
    expect(page.data.every((file) => !file.capabilities.delete)).toBe(true);
  });

  it("caps the chat's loopback bearer with the permissions it carries", async () => {
    const loopback = (permissions: string[]) => ({
      Authorization: `Bearer ${mintMcpLoopbackToken({
        userId: member.user.id,
        email: member.user.email,
        name: member.user.name,
        orgId: owner.orgId,
        orgRole: "member",
        permissions,
      })}`,
      "X-Org-Id": owner.orgId,
    });
    const full = await list(loopback(["files:read", "runs:read-all", "files:delete"]));
    expect(ids(full)).toEqual(pick(...memberRows));
    // Without `runs:read-all` in its ceiling, the supervision arms drop out everywhere.
    const capped = await list(loopback(["files:read"]));
    expect(ids(capped)).toEqual(
      pick("unMemberOutput", "deuxMemberOutput", "deuxMemberChat", "defaultMemberOutput"),
    );
  });
});
