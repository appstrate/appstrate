// SPDX-License-Identifier: Apache-2.0

/**
 * Run inputs follow one rule wherever the file lives (#2287): an `appfile://`
 * resolves in the FILE's own space, under the caller's grant there as its
 * credential reaches it (`files:read` required), then the container ACL and
 * the `download` capability. The one widening is the issuing chat
 * conversation's own files. Every refusal is the 404 of a missing file, and
 * each consumed file is audited (`file.consumed`) in the run's space.
 *
 * Launched through `POST /api/runs/inline` (`context_files`), which shares the
 * agent route's input resolution (`parseRequestInput`), and through the MCP
 * `invoke_operation runInline` that dispatches to it.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { and, eq } from "drizzle-orm";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import {
  authHeaders,
  createTestContext,
  memberContext,
  type TestContext,
} from "../../helpers/auth.ts";
import { seedApiKey, seedSpace, seedSpaceGrant } from "../../helpers/seed.ts";
import { loopbackHeaders } from "../../helpers/loopback.ts";
import {
  auditEvents,
  chatSessions,
  fileLinks,
  files,
  runs,
  spaceMembers,
  spaceRoles,
  uploads,
} from "@appstrate/db/schema";
import { uploadStream } from "@appstrate/db/storage";
import { createUpload } from "../../../src/services/uploads.ts";
import { createFileFromStream, createFileFromUpload } from "../../../src/services/files.ts";
import { ensurePersonalSpaceFor } from "../../../src/services/spaces.ts";
import { fileUri } from "@appstrate/core/file-uri";
import {
  createFakeOrchestrator,
  seedDefaultOrgModel,
  waitForRunPipelineSettled,
} from "../../helpers/run-connection-fixtures.ts";
import { _setOrchestratorForTesting } from "../../../src/services/orchestrator/index.ts";
import { installRuntimeBoundSystemPackages } from "../../helpers/runtime-bound-system-packages.ts";
import { MCP_ACCEPT, type JsonRpcEnvelope } from "../../helpers/mcp.ts";
import { registerTestPlatformApp } from "../../helpers/platform-app.ts";

const app = getTestApp();
await registerTestPlatformApp();

/** What an inline launch asks in the run's space, plus the file read the rule adds. */
const LAUNCHES_HERE = ["agents:read", "agents:write", "agents:run", "runs:read", "files:read"];

describe("run inputs across spaces", () => {
  let ctx: TestContext;
  let teamB: string;
  let restoreSystemPackages: () => void;

  beforeAll(() => {
    _setOrchestratorForTesting(createFakeOrchestrator());
  });

  afterAll(() => {
    _setOrchestratorForTesting(null);
  });

  beforeEach(async () => {
    await truncateAll();
    restoreSystemPackages = await installRuntimeBoundSystemPackages();
    ctx = await createTestContext({ orgSlug: "crossinputs" });
    await seedDefaultOrgModel(ctx);
    teamB = (await seedSpace({ orgId: ctx.orgId, name: "Équipe B" })).id;
  });

  afterEach(async () => {
    await waitForRunPipelineSettled();
    restoreSystemPackages();
  });

  /** The body of an inline run mounting `uris`. */
  function inlineRun(uris: string[]) {
    return {
      manifest: {
        name: "@inline/r-ignored",
        display_name: "Lecture du fichier",
        version: "0.0.0",
        type: "agent",
        schema_version: "0.1",
        dependencies: { skills: {} },
      },
      prompt: "Lis le fichier.",
      context_files: uris,
    };
  }

  /** An inline run in `spaceId` mounting `uris`. */
  function launch(headers: Record<string, string>, spaceId: string, uris: string[]) {
    return app.request("/api/runs/inline", {
      method: "POST",
      headers: { ...headers, "X-Space-Id": spaceId, "Content-Type": "application/json" },
      body: JSON.stringify(inlineRun(uris)),
    });
  }

  /** The same launch through the organization MCP endpoint's `invoke_operation`: its status. */
  async function launchThroughMcp(
    headers: Record<string, string>,
    spaceId: string,
    uris: string[],
  ): Promise<number> {
    const res = await app.request(`/api/mcp/o/${ctx.orgId}`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", Accept: MCP_ACCEPT },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "invoke_operation",
          arguments: { operation_id: "runInline", space_id: spaceId, body: inlineRun(uris) },
        },
      }),
    });
    const envelope = (await res.json()) as JsonRpcEnvelope;
    const content = (envelope.result?.content as Array<{ text: string }>) ?? [];
    return (JSON.parse(content[0]!.text) as { status: number }).status;
  }

  /** An output of a run `userId` launched in `spaceId`: readable by its launcher. */
  async function runOutput(spaceId: string, userId: string): Promise<string> {
    const runId = `run_${crypto.randomUUID()}`;
    await db.insert(runs).values({
      id: runId,
      orgId: ctx.orgId,
      spaceId,
      packageId: null,
      status: "success",
      userId,
    });
    const { row } = await createFileFromStream(
      { orgId: ctx.orgId, spaceId },
      runId,
      { userId, endUserId: null },
      null,
      {
        name: "rapport.txt",
        mime: "text/plain",
        body: new Blob([new TextEncoder().encode("rapport")]).stream(),
      },
    );
    return fileUri(row.id);
  }

  /** A chat upload of `userId`, held by conversation `sessionId`, in their personal space by default. */
  async function chatUpload(userId: string, sessionId: string, spaceId?: string): Promise<string> {
    const scope = {
      orgId: ctx.orgId,
      spaceId: spaceId ?? (await ensurePersonalSpaceFor(ctx.orgId, userId)).id,
    };
    await db
      .insert(chatSessions)
      .values({ id: sessionId, orgId: ctx.orgId, userId })
      .onConflictDoNothing();
    const bytes = new TextEncoder().encode("pièce jointe");
    const up = await createUpload({
      ...scope,
      createdBy: userId,
      name: "joint.txt",
      size: bytes.byteLength,
      mime: "text/plain",
    });
    const [staged] = await db
      .select({ storageKey: uploads.storageKey })
      .from(uploads)
      .where(eq(uploads.id, up.id));
    const [bucket, ...rest] = staged!.storageKey.split("/");
    await uploadStream(bucket!, rest.join("/"), new Blob([bytes]).stream(), { exclusive: true });
    const file = await createFileFromUpload(scope, { type: "user", id: userId }, up.id, {
      chatSessionId: sessionId,
    });
    return fileUri(file.id);
  }

  /** A launch upload of `userId`, staged in `spaceId`: its `upload://` URI. */
  async function stagedUpload(userId: string, spaceId: string): Promise<string> {
    const bytes = new TextEncoder().encode("lancement");
    const up = await createUpload({
      orgId: ctx.orgId,
      spaceId,
      createdBy: userId,
      name: "lancement.txt",
      size: bytes.byteLength,
      mime: "text/plain",
    });
    const [staged] = await db
      .select({ storageKey: uploads.storageKey })
      .from(uploads)
      .where(eq(uploads.id, up.id));
    const [bucket, ...rest] = staged!.storageKey.split("/");
    await uploadStream(bucket!, rest.join("/"), new Blob([bytes]).stream(), { exclusive: true });
    return `upload://${up.id}`;
  }

  async function launchedRunId(res: Response): Promise<string> {
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  it("a team space file feeds a run in another space, linked and audited there", async () => {
    const uri = await runOutput(ctx.defaultSpaceId, ctx.user.id);
    const runId = await launchedRunId(await launch(authHeaders(ctx), teamB, [uri]));

    const fileId = uri.replace("appfile://", "");
    const links = await db.select().from(fileLinks).where(eq(fileLinks.consumerRunId, runId));
    expect(links.map((link) => link.fileId)).toEqual([fileId]);
    const audit = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "file.consumed"), eq(auditEvents.resourceId, fileId)));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      spaceId: teamB,
      actorType: "user",
      actorId: ctx.user.id,
      resourceType: "file",
      after: { runId, fileSpaceId: ctx.defaultSpaceId },
    });
  });

  it("the launcher's personal space file feeds a run in a team space, audited once", async () => {
    const personal = (await ensurePersonalSpaceFor(ctx.orgId, ctx.user.id)).id;
    const uri = await chatUpload(ctx.user.id, `chs_${crypto.randomUUID()}`);
    const runId = await launchedRunId(await launch(authHeaders(ctx), teamB, [uri, uri]));
    const audits = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, "file.consumed"),
          eq(auditEvents.resourceId, uri.replace("appfile://", "")),
        ),
      );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ spaceId: teamB, after: { runId, fileSpaceId: personal } });
  });

  it("one rule whatever the door: REST and invoke_operation agree on a cross-space input", async () => {
    const ofA = await runOutput(ctx.defaultSpaceId, ctx.user.id);
    const sessionId = `chs_${crypto.randomUUID()}`;
    const own = await chatUpload(ctx.user.id, sessionId);
    // A credential bound to [A, B] (the chat's bearer, as `run_and_wait` launches with it in B)
    // acts in the one space a request entered: a file of A is a missing one from B, its own
    // conversation's upload is read wherever it launches.
    const bound = loopbackHeaders(ctx, ctx.orgId, {
      orgRole: "owner",
      permissions: [...LAUNCHES_HERE, "models:read", "mcp:read", "mcp:invoke"],
      spaceIds: [ctx.defaultSpaceId, teamB],
      chatSessionId: sessionId,
    });
    expect((await launch(bound, teamB, [ofA])).status).toBe(404);
    expect(await launchThroughMcp(bound, teamB, [ofA])).toBe(404);
    expect((await launch(bound, ctx.defaultSpaceId, [ofA])).status).toBe(201);
    expect((await launch(bound, teamB, [own])).status).toBe(201);
    expect(await launchThroughMcp(bound, teamB, [own])).toBe(201);
    // A session reaches every space it holds a role in, through both doors.
    const session = { Cookie: ctx.cookie, "X-Org-Id": ctx.orgId };
    expect((await launch(session, teamB, [ofA])).status).toBe(201);
    expect(await launchThroughMcp(session, teamB, [ofA])).toBe(201);
  });

  it("refuses a file of a space where the caller lacks files:read, as a missing one", async () => {
    const member = await memberContext(ctx, "member");
    await seedSpaceGrant({
      orgId: ctx.orgId,
      spaceId: teamB,
      userId: member.user.id,
      permissions: LAUNCHES_HERE,
    });
    // In A the member reads runs, not files.
    await seedSpaceGrant({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: member.user.id,
      permissions: ["agents:read", "runs:read"],
    });
    const uri = await runOutput(ctx.defaultSpaceId, member.user.id);
    expect((await launch(authHeaders(member), teamB, [uri])).status).toBe(404);
  });

  it("same-space inputs require files:read too", async () => {
    const member = await memberContext(ctx, "member");
    await seedSpaceGrant({
      orgId: ctx.orgId,
      spaceId: teamB,
      userId: member.user.id,
      permissions: LAUNCHES_HERE.filter((permission) => permission !== "files:read"),
    });
    const uri = await runOutput(teamB, member.user.id);
    expect((await launch(authHeaders(member), teamB, [uri])).status).toBe(404);
  });

  it("refuses a space the caller is not in", async () => {
    const member = await memberContext(ctx, "member");
    await seedSpaceGrant({
      orgId: ctx.orgId,
      spaceId: teamB,
      userId: member.user.id,
      permissions: LAUNCHES_HERE,
    });
    const closed = (await seedSpace({ orgId: ctx.orgId, name: "Fermé", visibility: "private" })).id;
    const uri = await runOutput(closed, member.user.id);
    expect((await launch(authHeaders(member), teamB, [uri])).status).toBe(404);
  });

  it("refuses another member's upload", async () => {
    const colleague = await memberContext(ctx, "member");
    const uri = await chatUpload(colleague.user.id, `chs_${crypto.randomUUID()}`);
    expect((await launch(authHeaders(ctx), teamB, [uri])).status).toBe(404);
  });

  it("an API key of space B reaches no other space", async () => {
    const key = await seedApiKey({
      orgId: ctx.orgId,
      spaceId: teamB,
      createdBy: ctx.user.id,
      scopes: LAUNCHES_HERE,
    });
    const headers = { Authorization: `Bearer ${key.rawKey}` };
    expect(
      (await launch(headers, teamB, [await runOutput(ctx.defaultSpaceId, ctx.user.id)])).status,
    ).toBe(404);
    expect(
      (await launch(headers, teamB, [await chatUpload(ctx.user.id, `chs_${crypto.randomUUID()}`)]))
        .status,
    ).toBe(404);
    // Its own space still resolves: the refusal is the space, not the key, which the audit names
    // as it names the key on `run.triggered`.
    const own = await runOutput(teamB, ctx.user.id);
    const runId = await launchedRunId(await launch(headers, teamB, [own]));
    const consumed = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "file.consumed"), eq(auditEvents.spaceId, teamB)));
    const [triggered] = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "run.triggered"), eq(auditEvents.resourceId, runId)));
    expect(consumed).toHaveLength(1);
    expect(consumed[0]).toMatchObject({
      actorType: "api_key",
      actorId: key.id,
      requestId: triggered!.requestId,
      resourceId: own.replace("appfile://", ""),
      after: { runId, fileSpaceId: teamB },
    });
    expect(consumed[0]!.requestId).not.toBeNull();
  });

  it("a chat turn bound to space B consumes its own conversation's files, and no other", async () => {
    const sessionId = `chs_${crypto.randomUUID()}`;
    const own = await chatUpload(ctx.user.id, sessionId);
    const otherConversation = await chatUpload(ctx.user.id, `chs_${crypto.randomUUID()}`);
    // The bearer of a turn limited to B: its allowlist does not hold the personal space.
    const bearer = (chatSessionId?: string) =>
      loopbackHeaders(ctx, ctx.orgId, {
        orgRole: "owner",
        permissions: [...LAUNCHES_HERE, "models:read"],
        spaceIds: [teamB],
        chatSessionId,
      });

    await launchedRunId(await launch(bearer(sessionId), teamB, [own]));
    expect((await launch(bearer(sessionId), teamB, [otherConversation])).status).toBe(404);
    expect((await launch(bearer(), teamB, [own])).status).toBe(404);
    // The ceiling still caps it: a bearer without files:read reads none of them.
    const noFiles = loopbackHeaders(ctx, ctx.orgId, {
      orgRole: "owner",
      permissions: [...LAUNCHES_HERE.filter((p) => p !== "files:read"), "models:read"],
      spaceIds: [teamB],
      chatSessionId: sessionId,
    });
    expect((await launch(noFiles, teamB, [own])).status).toBe(404);

    // The widening is the conversation's uploads in the caller's own personal space: a file it
    // holds in a team space the bearer does not reach resolves like any other file there.
    const inTeam = await chatUpload(ctx.user.id, sessionId, ctx.defaultSpaceId);
    expect((await launch(bearer(sessionId), teamB, [inTeam])).status).toBe(404);
    // Never under a role preview.
    const previewing = loopbackHeaders(ctx, ctx.orgId, {
      orgRole: "owner",
      permissions: [...LAUNCHES_HERE, "models:read"],
      spaceIds: [teamB],
      chatSessionId: sessionId,
      viewAs: {
        orgId: ctx.orgId,
        orgRole: "member",
        space: { spaceId: teamB, role: { kind: "preset", preset: "admin" } },
      },
    });
    expect((await launch(previewing, teamB, [own])).status).toBe(404);
    await launchedRunId(await launch(previewing, teamB, [await runOutput(teamB, ctx.user.id)]));
  });

  it("a chat turn bound to space B sees its own personal upload as read-only by id and in a run", async () => {
    const sessionId = `chs_${crypto.randomUUID()}`;
    const uri = await chatUpload(ctx.user.id, sessionId);
    const fileId = uri.replace("appfile://", "");
    const bearer = {
      ...loopbackHeaders(ctx, ctx.orgId, {
        orgRole: "owner",
        permissions: [...LAUNCHES_HERE, "models:read", "files:delete"],
        spaceIds: [teamB],
        chatSessionId: sessionId,
      }),
      "X-Space-Id": teamB,
    };
    const read = await app.request(`/api/files/${fileId}`, { headers: bearer });
    expect(read.status).toBe(200);
    // What GET advertises is what the lifecycle doors do.
    const { capabilities } = (await read.json()) as { capabilities: unknown };
    expect(capabilities).toMatchObject({ keep: false, delete: false });
    const runId = await launchedRunId(await launch(bearer, teamB, [uri]));
    const list = await app.request(`/api/files?runId=${runId}`, { headers: bearer });
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      data: [{ id: fileId, capabilities }],
    });

    // The conversation widens reads only: delete and keep take the file's space grants.
    const keep = await app.request(`/api/files/${fileId}/keep`, {
      method: "POST",
      headers: bearer,
    });
    expect(keep.status).toBe(404);
    const removed = await app.request(`/api/files/${fileId}`, {
      method: "DELETE",
      headers: bearer,
    });
    expect(removed.status).toBe(404);
    expect((await app.request(`/api/files/${fileId}`, { headers: bearer })).status).toBe(200);
  });

  it("a run's file list shows a consumed input by its own space's rule", async () => {
    const uri = await chatUpload(ctx.user.id, `chs_${crypto.randomUUID()}`);
    const fileId = uri.replace("appfile://", "");
    const runId = await launchedRunId(await launch(authHeaders(ctx), teamB, [uri]));
    const listed = async (headers: Record<string, string>) => {
      const res = await app.request(`/api/files?runId=${runId}`, {
        headers: { ...headers, "X-Space-Id": teamB },
      });
      expect(res.status).toBe(200);
      return ((await res.json()) as { data: { id: string }[] }).data.map((file) => file.id);
    };

    // The author reaches their personal space: the input is listed with the run.
    expect(await listed(authHeaders(ctx))).toEqual([fileId]);
    // A colleague reading every run of B does not reach it: the run lists nothing of it.
    const colleague = await memberContext(ctx, "member");
    await seedSpaceGrant({
      orgId: ctx.orgId,
      spaceId: teamB,
      userId: colleague.user.id,
      permissions: ["runs:read", "runs:read-all", "files:read"],
    });
    expect(await listed(authHeaders(colleague))).toEqual([]);
  });

  it("a run's file list names no input of a run the caller may not read", async () => {
    // The colleague reads their own output in A, and their own runs only in B.
    const colleague = await memberContext(ctx, "member");
    for (const spaceId of [ctx.defaultSpaceId, teamB]) {
      await seedSpaceGrant({
        orgId: ctx.orgId,
        spaceId,
        userId: colleague.user.id,
        permissions: ["runs:read", "files:read"],
      });
    }
    const theirs = await runOutput(ctx.defaultSpaceId, colleague.user.id);
    // The author (reading every run of A) gives it to a run of theirs in B.
    const runId = await launchedRunId(await launch(authHeaders(ctx), teamB, [theirs]));
    const res = await app.request(`/api/files?runId=${runId}`, {
      headers: { ...authHeaders(colleague), "X-Space-Id": teamB },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown[] }).data).toEqual([]);
  });

  it("lifecycle by id follows the file's own space, as its capabilities say, from any door", async () => {
    const member = await memberContext(ctx, "member");
    await seedSpaceGrant({
      orgId: ctx.orgId,
      spaceId: teamB,
      userId: member.user.id,
      permissions: LAUNCHES_HERE,
    });
    // In A the member manages files; in B, where it launches, it does not.
    await seedSpaceGrant({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: member.user.id,
      permissions: ["runs:read", "runs:read-all", "files:read", "files:delete"],
    });
    const uri = await runOutput(ctx.defaultSpaceId, ctx.user.id);
    const fileId = uri.replace("appfile://", "");
    const runId = await launchedRunId(await launch(authHeaders(member), teamB, [uri]));
    const inB = { ...authHeaders(member), "X-Space-Id": teamB };
    type Capabilities = { keep: boolean; delete: boolean };

    const listed = (await (
      await app.request(`/api/files?runId=${runId}`, { headers: inB })
    ).json()) as {
      data: { id: string; capabilities: Capabilities }[];
    };
    const read = (await (await app.request(`/api/files/${fileId}`, { headers: inB })).json()) as {
      capabilities: Capabilities;
    };
    expect(listed.data).toEqual([
      expect.objectContaining({ id: fileId, capabilities: read.capabilities }),
    ]);
    expect(read.capabilities).toMatchObject({ keep: true, delete: true });

    const kept = await app.request(`/api/files/${fileId}/keep`, { method: "POST", headers: inB });
    expect(kept.status).toBe(200);
    // The run of B keeps no claim on a file of A.
    const deleted = await app.request(`/api/files/${fileId}`, { method: "DELETE", headers: inB });
    expect(deleted.status).toBe(204);
    expect(await db.select().from(files).where(eq(files.id, fileId))).toEqual([]);
    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "file.deleted"), eq(auditEvents.resourceId, fileId)));
    expect(audit).toMatchObject({ spaceId: ctx.defaultSpaceId });
  });

  it("a launcher who lost runs:read still lists the files of its run, their container", async () => {
    const member = await memberContext(ctx, "member");
    await seedSpaceGrant({
      orgId: ctx.orgId,
      spaceId: teamB,
      userId: member.user.id,
      permissions: LAUNCHES_HERE,
    });
    await seedSpaceGrant({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: member.user.id,
      permissions: ["runs:read", "files:read"],
    });
    const uri = await runOutput(ctx.defaultSpaceId, member.user.id);
    const staged = await stagedUpload(member.user.id, teamB);
    const base = inlineRun([]);
    const withUpload = await app.request("/api/runs/inline", {
      method: "POST",
      headers: { ...authHeaders(member), "X-Space-Id": teamB, "Content-Type": "application/json" },
      body: JSON.stringify({
        ...base,
        context_files: undefined,
        manifest: {
          ...base.manifest,
          input: {
            schema: {
              type: "object",
              properties: {
                doc: { type: "string", format: "uri", contentMediaType: "text/plain" },
              },
            },
          },
        },
        input: { doc: staged },
      }),
    });
    const runIds = [
      await launchedRunId(await launch(authHeaders(member), teamB, [uri])),
      await launchedRunId(withUpload),
    ];
    const listed = async (runId: string, caller: TestContext = member) => {
      const res = await app.request(`/api/files?runId=${runId}`, {
        headers: { ...authHeaders(caller), "X-Space-Id": teamB },
      });
      return ((await res.json()) as { data: { id: string }[] }).data.map((file) => file.id);
    };
    const before = [await listed(runIds[0]!), await listed(runIds[1]!)];
    expect(before[0]).toEqual([uri.replace("appfile://", "")]);
    expect(before[1]).toHaveLength(1);
    // A colleague reading only their own runs in B is listed nothing of the member's runs.
    const colleague = await memberContext(ctx, "member");
    await seedSpaceGrant({
      orgId: ctx.orgId,
      spaceId: teamB,
      userId: colleague.user.id,
      permissions: ["runs:read", "files:read"],
    });
    for (const runId of runIds) expect(await listed(runId, colleague)).toEqual([]);
    // Its role in B keeps `files:read` and loses `runs:read`: the files of a run follow the run
    // as their container (its launcher), as a read by id does, so the lists are unchanged.
    const [membership] = await db
      .select({ roleId: spaceMembers.customRoleId })
      .from(spaceMembers)
      .where(and(eq(spaceMembers.spaceId, teamB), eq(spaceMembers.userId, member.user.id)));
    await db
      .update(spaceRoles)
      .set({ permissions: ["files:read"] })
      .where(eq(spaceRoles.id, membership!.roleId!));
    expect([await listed(runIds[0]!), await listed(runIds[1]!)]).toEqual(before);
  });

  it("a creator without files:read still deletes and keeps their own upload", async () => {
    const member = await memberContext(ctx, "member");
    await seedSpaceGrant({
      orgId: ctx.orgId,
      spaceId: teamB,
      userId: member.user.id,
      permissions: ["files:delete"],
    });
    const fileId = (await chatUpload(member.user.id, `chs_${crypto.randomUUID()}`, teamB)).replace(
      "appfile://",
      "",
    );
    const inB = { ...authHeaders(member), "X-Space-Id": teamB };
    // Reading it needs files:read; acting on its lifecycle needs its own capability.
    expect((await app.request(`/api/files/${fileId}`, { headers: inB })).status).toBe(404);
    const kept = await app.request(`/api/files/${fileId}/keep`, { method: "POST", headers: inB });
    expect(kept.status).toBe(200);
    const deleted = await app.request(`/api/files/${fileId}`, { method: "DELETE", headers: inB });
    expect(deleted.status).toBe(204);
  });

  it("a team run keeps no claim on a personal upload: it dies with its conversation", async () => {
    const sessionId = `chs_${crypto.randomUUID()}`;
    const uri = await chatUpload(ctx.user.id, sessionId);
    await launchedRunId(await launch(authHeaders(ctx), teamB, [uri]));

    const removed = await app.request(`/api/orgs/${ctx.orgId}/chat/sessions/${sessionId}`, {
      method: "DELETE",
      headers: authHeaders(ctx),
    });
    expect(removed.status).toBe(204);
    const fileId = uri.replace("appfile://", "");
    expect(await db.select().from(files).where(eq(files.id, fileId))).toEqual([]);
    // Launching the same input again resolves nothing: a rerun of that run fails the same way.
    expect((await launch(authHeaders(ctx), teamB, [uri])).status).toBe(404);
  });
});
