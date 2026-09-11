// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for `context_files` on POST /api/runs/inline — fan-in by
 * reference (B2).
 *
 * Like the sibling inline-run suite, these never assert `201`: a successful
 * launch fires `executeAgentInBackground()`, whose async tail keeps writing to
 * `runs` / `run_logs` past the end of the test and races the next
 * `truncateAll()`. The positive paths are therefore probed with a deliberately
 * unknown `modelId`, which is rejected by `assertExplicitModelExists` INSIDE
 * `triggerInlineRun` — i.e. strictly AFTER the context files have been
 * declared, ACL-checked and streamed. Reaching that model 404 instead of the
 * `file_uri_in_prompt` 400 is what proves the injection ran.
 *
 * The mount itself (bytes in the workspace, ACL, `file_links`) is asserted
 * end-to-end in `test/integration/services/input-parser-context-files.test.ts`.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { packages, runs } from "@appstrate/db/schema";
import { createFileFromStream } from "../../../src/services/files.ts";
import { CONTEXT_FILES_FIELD } from "../../../src/services/inline-run.ts";
import { fileUri } from "@appstrate/core/file-uri";

const app = getTestApp();

const MISSING_DOC = "appfile://file_00000000-0000-0000-0000-000000000000";
/** Unknown model → 404 raised after the injection + mount, see the file header. */
const UNKNOWN_MODEL = "00000000-0000-0000-0000-0000000000ff";

function validManifest(): Record<string, unknown> {
  return {
    name: "@inline/r-ignored",
    display_name: "Ad-hoc Agent",
    version: "0.0.0",
    type: "agent",
    schema_version: "0.1",
    dependencies: { skills: {} },
  };
}

interface ProblemBody {
  code?: string;
  detail?: string;
  errors?: { code?: string; field?: string; message?: string }[];
}

describe("POST /api/runs/inline — context_files", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "ctxdocsroute" });
  });

  async function post(body: unknown): Promise<Response> {
    return app.request("/api/runs/inline", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  /** A sibling run's deliverable in this org+app, readable by the test actor. */
  async function seedReadableFile(name = "research.json"): Promise<string> {
    const runId = `run_${crypto.randomUUID()}`;
    await db.insert(runs).values({
      id: runId,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      packageId: null,
      status: "success",
    });
    const { row } = await createFileFromStream(
      { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId },
      runId,
      { userId: null, endUserId: null },
      null,
      {
        name,
        mime: "application/json",
        body: new Blob([new TextEncoder().encode('{"a":1}')]).stream(),
      },
    );
    return row.id;
  }

  async function shadowRows(): Promise<unknown[]> {
    return db.select().from(packages).where(eq(packages.ephemeral, true));
  }

  // --- Reserved name -------------------------------------------------------

  it("rejects a manifest that declares the reserved _context_files field", async () => {
    const manifest = {
      ...validManifest(),
      input: {
        schema: {
          type: "object",
          properties: { [CONTEXT_FILES_FIELD]: { type: "string" } },
        },
      },
    };
    const res = await post({ manifest, prompt: "hi" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ProblemBody;
    expect(body.detail ?? "").toContain(CONTEXT_FILES_FIELD);
    expect(await shadowRows()).toHaveLength(0);
  });

  it("rejects an input that carries the reserved _context_files field", async () => {
    const res = await post({
      manifest: validManifest(),
      prompt: "hi",
      input: { [CONTEXT_FILES_FIELD]: [MISSING_DOC] },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ProblemBody;
    expect(body.detail ?? "").toContain(CONTEXT_FILES_FIELD);
  });

  it("rejects the reserved name on the validate endpoint too", async () => {
    const manifest = {
      ...validManifest(),
      input: {
        schema: {
          type: "object",
          properties: { [CONTEXT_FILES_FIELD]: { type: "string" } },
        },
      },
    };
    const res = await app.request("/api/runs/inline/validate", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ manifest, prompt: "hi" }),
    });
    expect(res.status).toBe(400);
  });

  // --- Argument shape ------------------------------------------------------

  it("rejects a context_files entry that is not an appfile:// URI", async () => {
    const res = await post({
      manifest: validManifest(),
      prompt: "hi",
      context_files: ["upload://upl_123"],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ProblemBody;
    expect(body.detail ?? "").toContain("appfile://");
  });

  // --- ACL -----------------------------------------------------------------

  it("returns 404 for a context file that does not exist", async () => {
    const res = await post({
      manifest: validManifest(),
      prompt: "hi",
      context_files: [MISSING_DOC],
    });
    expect(res.status).toBe(404);
    expect(await shadowRows()).toHaveLength(0);
  });

  it("returns 404 for a context file owned by another space", async () => {
    const other = await createTestContext({ orgSlug: "ctxdocsforeign" });
    const foreignRunId = `run_${crypto.randomUUID()}`;
    await db.insert(runs).values({
      id: foreignRunId,
      orgId: other.orgId,
      spaceId: other.defaultSpaceId,
      packageId: null,
      status: "success",
    });
    const { row } = await createFileFromStream(
      { orgId: other.orgId, spaceId: other.defaultSpaceId },
      foreignRunId,
      { userId: null, endUserId: null },
      null,
      {
        name: "secret.md",
        mime: "text/markdown",
        body: new Blob([new TextEncoder().encode("classified")]).stream(),
      },
    );

    const res = await post({
      manifest: validManifest(),
      prompt: "hi",
      context_files: [fileUri(row.id)],
    });
    expect(res.status).toBe(404);
  });

  // --- B2: explicit context_files mount --------------------------------

  it("mounts a readable context file with no manifest change", async () => {
    const docId = await seedReadableFile();
    const res = await post({
      manifest: validManifest(),
      prompt: "Compile the findings.",
      context_files: [fileUri(docId)],
      modelId: UNKNOWN_MODEL,
    });
    // Past the mount: the only remaining rejection is the unknown model, raised
    // inside `triggerInlineRun` after the file was ACL-checked and streamed.
    expect(res.status).toBe(404);
    const body = (await res.json()) as ProblemBody;
    expect(body.detail ?? "").toMatch(/Model/);
  });
});
