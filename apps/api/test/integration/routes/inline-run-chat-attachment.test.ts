// SPDX-License-Identifier: Apache-2.0

/**
 * Regression: a file attached in the chat and handed to an INLINE run must be
 * an input OF THAT RUN — present in `runs.input`, counted in
 * `file_counts.input`, and protected by a `file_links` consumption row.
 *
 * Reproduces the chat's exact sequence:
 *   1. the composer stages an upload and the chat materializes it into a
 *      chat-session-scoped file (`resolveChatAttachment`);
 *   2. the model reads the resulting `appfile://` URI off the attachment line
 *      and calls `run_and_wait` (kind:"inline") with it;
 *   3. `run-and-wait-client` POSTs the launch body to `/api/runs/inline`.
 *
 * Step 3 goes through the REAL client (`launchRunAndWait`) rather than a
 * hand-written body, because that is where the defect lived: the client builds
 * the launch body from an allowlist, and a file argument it does not recognise
 * is dropped BEFORE the HTTP call — the route never sees it, so it cannot
 * answer with its field-precise 400 either. The run just starts with no file
 * and every layer reports success.
 *
 * The retired spelling gets its own case. `context_documents` is the pre-#1177
 * ARGUMENT name of the `run_and_wait` tool, and a model reaches for it from its
 * own transcript (an earlier turn of the same conversation) or from a tool
 * listing taken before the upgrade — the MCP server advertises
 * `tools.listChanged: false`, so calling the old shape afterwards is correct
 * client behaviour. It survives nowhere: the client refuses every argument it
 * does not declare, and `RUN_AND_WAIT_RETIRED_ARGUMENTS` only names the
 * replacement in the refusal message — "a message-quality table, not an alias
 * table: nothing here is accepted, canonicalized or relayed". The HTTP route
 * never knew the old name either (its body schema is `.strict()`). What that
 * case pins is the refusal rather than the drop: a name nobody reads is
 * invisible, which is the failure mode above wearing a retired spelling.
 *
 * The third case is the floor — no file argument at all still launches, with
 * `runs.input` left null — so the allowlist cannot be read as gating the plain
 * prompt path.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { chatSessions, fileLinks, runs, uploads } from "@appstrate/db/schema";
import { uploadStream } from "@appstrate/db/storage";
import { createUpload } from "../../../src/services/uploads.ts";
import { resolveChatAttachment } from "../../../src/services/files.ts";
import { CONTEXT_FILES_FIELD } from "../../../src/services/inline-run.ts";
import { launchRunAndWait } from "@appstrate/core/run-and-wait-client";
import { parseFileUri } from "@appstrate/core/file-uri";
import {
  createFakeOrchestrator,
  seedDefaultOrgModel,
  waitForRunPipelineSettled,
} from "../../helpers/run-connection-fixtures.ts";
import { _setOrchestratorForTesting } from "../../../src/services/orchestrator/index.ts";

const app = getTestApp();

describe("inline run launched from the chat with an attached file", () => {
  let ctx: TestContext;

  beforeAll(() => {
    _setOrchestratorForTesting(createFakeOrchestrator());
  });

  afterAll(() => {
    _setOrchestratorForTesting(null);
  });

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "chatattach" });
    await seedDefaultOrgModel(ctx);
  });

  // Drain in `afterEach`, never at the tail of a test body: the trigger is
  // fire-and-forget, so a FAILING assertion would leave the pipeline's
  // background writes racing the next `truncateAll()`.
  afterEach(waitForRunPipelineSettled);

  /** The composer's 2-step upload, as `ui/upload.ts` performs it. */
  async function stageUpload(name: string, content: string): Promise<string> {
    const bytes = new TextEncoder().encode(content);
    const up = await createUpload({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      createdBy: ctx.user.id,
      name,
      size: bytes.byteLength,
      mime: "text/plain",
    });
    const [row] = await db
      .select({ storageKey: uploads.storageKey })
      .from(uploads)
      .where(eq(uploads.id, up.id));
    const [bucket, ...rest] = row!.storageKey.split("/");
    await uploadStream(bucket!, rest.join("/"), new Blob([bytes]).stream(), { exclusive: true });
    return up.id;
  }

  /** Attach a file to a chat session the way a composer upload does. */
  async function attachToChat(): Promise<{ uri: string; fileId: string }> {
    const sessionId = `chs_${crypto.randomUUID()}`;
    await db.insert(chatSessions).values({ id: sessionId, orgId: ctx.orgId, userId: ctx.user.id });
    const uploadId = await stageUpload("brief.txt", "the attached brief");
    const resolved = await resolveChatAttachment({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
      chatSessionId: sessionId,
      uri: `upload://${uploadId}`,
    });
    return { uri: resolved.uri, fileId: parseFileUri(resolved.uri)! };
  }

  /** Drive the REAL run_and_wait launch path against the test app. */
  async function launchFromChat(args: Record<string, unknown>) {
    return launchRunAndWait(args, {
      origin: "http://localhost",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      fetch: ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
        app.request(String(input), init)) as unknown as typeof fetch,
    });
  }

  /** The three places an input file has to appear once the run exists. */
  async function expectFileIsRunInput(runId: string, uri: string, fileId: string): Promise<void> {
    const [row] = await db.select().from(runs).where(eq(runs.id, runId));
    expect(row).toBeDefined();
    expect(row!.input).toMatchObject({ [CONTEXT_FILES_FIELD]: [uri] });

    const res = await app.request(`/api/runs/${runId}`, { headers: authHeaders(ctx) });
    expect(res.status).toBe(200);
    const dto = (await res.json()) as { file_counts?: { input?: number } };
    expect(dto.file_counts?.input).toBe(1);

    const links = await db.select().from(fileLinks).where(eq(fileLinks.consumerRunId, runId));
    expect(links.map((l) => l.fileId)).toEqual([fileId]);
  }

  it("makes the attached file an input of the run", async () => {
    const { uri, fileId } = await attachToChat();

    const launched = await launchFromChat({
      kind: "inline",
      manifest: { display_name: "Analyse du fichier joint" },
      prompt: "Résume le fichier joint.",
      context_files: [uri],
    });

    expect(launched.ok).toBe(true);
    if (!launched.ok) return;
    await expectFileIsRunInput(launched.launch.runId, uri, fileId);
  });

  it("refuses the retired tool-argument spelling instead of ignoring it", async () => {
    // `context_documents` is no longer canonicalized. It must still be named
    // in a refusal rather than left unrecognised: the launch body is built
    // from an allowlist, so an argument nobody reads is invisible — the run
    // would start with nothing mounted and every layer would report success.
    const { uri } = await attachToChat();

    const launched = await launchFromChat({
      kind: "inline",
      manifest: { display_name: "Analyse du fichier joint" },
      prompt: "Résume le fichier joint.",
      context_documents: [uri],
    });

    expect(launched.ok).toBe(false);
  });

  it("still launches a run with no file at all", async () => {
    const launched = await launchFromChat({
      kind: "inline",
      manifest: { display_name: "Sans fichier" },
      prompt: "Fais le travail.",
    });

    expect(launched.ok).toBe(true);
    if (!launched.ok) return;
    const [row] = await db.select().from(runs).where(eq(runs.id, launched.launch.runId));
    expect(row!.input).toBeNull();
  });
});
