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
 * Both spellings are covered. `context_documents` is the pre-#1177 ARGUMENT
 * name of the `run_and_wait` tool, and a model reaches for it from its own
 * transcript (an earlier turn of the same conversation) or from a tool listing
 * taken before the upgrade — the MCP server advertises `tools.listChanged:
 * false`, so calling the old shape afterwards is correct client behaviour. It
 * survives ONLY as a tool argument: `run-and-wait-client` canonicalizes it to
 * `context_files` while building the launch body, and the HTTP route no longer
 * knows the old name at all (its body schema is `.strict()`, so a raw
 * `context_documents` on the wire is a 400). That canonicalization is exactly
 * what this case pins.
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
      applicationId: ctx.defaultAppId,
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
      applicationId: ctx.defaultAppId,
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

  it("makes the attached file an input of the run under the legacy tool-argument spelling", async () => {
    const { uri, fileId } = await attachToChat();

    const launched = await launchFromChat({
      kind: "inline",
      manifest: { display_name: "Analyse du fichier joint" },
      prompt: "Résume le fichier joint.",
      context_documents: [uri],
    });

    expect(launched.ok).toBe(true);
    if (!launched.ok) return;
    await expectFileIsRunInput(launched.launch.runId, uri, fileId);
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
