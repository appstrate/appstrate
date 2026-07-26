// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for `context_documents` on POST /api/runs/inline — fan-in by
 * reference (B2) and the prompt-URI auto-repair (B3).
 *
 * Like the sibling inline-run suite, these never assert `201`: a successful
 * launch fires `executeAgentInBackground()`, whose async tail keeps writing to
 * `runs` / `run_logs` past the end of the test and races the next
 * `truncateAll()`. The positive paths are therefore probed with a deliberately
 * unknown `modelId`, which is rejected by `assertExplicitModelExists` INSIDE
 * `triggerInlineRun` — i.e. strictly AFTER the context documents have been
 * declared, ACL-checked and streamed. Reaching that model 404 instead of the
 * `document_uri_in_prompt` 400 is what proves the injection ran.
 *
 * The mount itself (bytes in the workspace, ACL, `document_links`) is asserted
 * end-to-end in `test/integration/services/input-parser-context-documents.test.ts`.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { packages, runs } from "@appstrate/db/schema";
import { createDocumentFromStream } from "../../../src/services/documents.ts";
import { CONTEXT_DOCUMENTS_FIELD } from "../../../src/services/inline-run.ts";
import { documentUri } from "@appstrate/core/document-uri";

const app = getTestApp();

const MISSING_DOC = "document://doc_00000000-0000-0000-0000-000000000000";
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

describe("POST /api/runs/inline — context_documents", () => {
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
  async function seedReadableDocument(name = "research.json"): Promise<string> {
    const runId = `run_${crypto.randomUUID()}`;
    await db.insert(runs).values({
      id: runId,
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      packageId: null,
      status: "success",
    });
    const { row } = await createDocumentFromStream(
      { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
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

  it("rejects a manifest that declares the reserved _context_documents field", async () => {
    const manifest = {
      ...validManifest(),
      input: {
        schema: {
          type: "object",
          properties: { [CONTEXT_DOCUMENTS_FIELD]: { type: "string" } },
        },
      },
    };
    const res = await post({ manifest, prompt: "hi" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ProblemBody;
    expect(body.detail ?? "").toContain(CONTEXT_DOCUMENTS_FIELD);
    expect(await shadowRows()).toHaveLength(0);
  });

  it("rejects an input that carries the reserved _context_documents field", async () => {
    const res = await post({
      manifest: validManifest(),
      prompt: "hi",
      input: { [CONTEXT_DOCUMENTS_FIELD]: [MISSING_DOC] },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ProblemBody;
    expect(body.detail ?? "").toContain(CONTEXT_DOCUMENTS_FIELD);
  });

  it("rejects the reserved name on the validate endpoint too", async () => {
    const manifest = {
      ...validManifest(),
      input: {
        schema: {
          type: "object",
          properties: { [CONTEXT_DOCUMENTS_FIELD]: { type: "string" } },
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

  it("rejects a context_documents entry that is not a document:// URI", async () => {
    const res = await post({
      manifest: validManifest(),
      prompt: "hi",
      context_documents: ["upload://upl_123"],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ProblemBody;
    expect(body.detail ?? "").toContain("document://");
  });

  // --- ACL -----------------------------------------------------------------

  it("returns 404 for a context document that does not exist", async () => {
    const res = await post({
      manifest: validManifest(),
      prompt: "hi",
      context_documents: [MISSING_DOC],
    });
    expect(res.status).toBe(404);
    expect(await shadowRows()).toHaveLength(0);
  });

  it("returns 404 for a context document owned by another application", async () => {
    const other = await createTestContext({ orgSlug: "ctxdocsforeign" });
    const foreignRunId = `run_${crypto.randomUUID()}`;
    await db.insert(runs).values({
      id: foreignRunId,
      orgId: other.orgId,
      applicationId: other.defaultAppId,
      packageId: null,
      status: "success",
    });
    const { row } = await createDocumentFromStream(
      { orgId: other.orgId, applicationId: other.defaultAppId },
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
      context_documents: [documentUri(row.id)],
    });
    expect(res.status).toBe(404);
  });

  // --- B2: explicit context_documents mount --------------------------------

  it("mounts a readable context document with no manifest change", async () => {
    const docId = await seedReadableDocument();
    const res = await post({
      manifest: validManifest(),
      prompt: "Compile the findings.",
      context_documents: [documentUri(docId)],
      modelId: UNKNOWN_MODEL,
    });
    // Past the mount: the only remaining rejection is the unknown model, raised
    // inside `triggerInlineRun` after the document was ACL-checked and streamed.
    expect(res.status).toBe(404);
    const body = (await res.json()) as ProblemBody;
    expect(body.detail ?? "").toMatch(/Model/);
  });

  // --- B3: auto-repair of prompt-named URIs ---------------------------------

  it("auto-repairs a prompt-named document the actor can read", async () => {
    const docId = await seedReadableDocument("brief.json");
    const res = await post({
      manifest: validManifest(),
      prompt: `Compile ${documentUri(docId)} into one report.`,
      modelId: UNKNOWN_MODEL,
    });
    // Before B3 this was a 400 `document_uri_in_prompt`; the URI is now routed
    // into the reserved field instead, so the request proceeds to the mount and
    // only the unknown model stops it.
    expect(res.status).toBe(404);
    const body = (await res.json()) as ProblemBody;
    expect(body.errors?.[0]?.code).not.toBe("document_uri_in_prompt");
    expect(body.detail ?? "").toMatch(/Model/);
  });

  it("still returns 400 for a prompt-named document that does not resolve", async () => {
    const res = await post({
      manifest: validManifest(),
      prompt: `Read ${MISSING_DOC} and summarise it.`,
      modelId: UNKNOWN_MODEL,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ProblemBody;
    expect(body.errors?.[0]?.code).toBe("document_uri_in_prompt");
    expect(body.errors?.[0]?.field).toBe("prompt");
    expect(await shadowRows()).toHaveLength(0);
  });

  it("still returns 400 for a prompt-named document owned by another application", async () => {
    const other = await createTestContext({ orgSlug: "ctxdocsforeign2" });
    const foreignRunId = `run_${crypto.randomUUID()}`;
    await db.insert(runs).values({
      id: foreignRunId,
      orgId: other.orgId,
      applicationId: other.defaultAppId,
      packageId: null,
      status: "success",
    });
    const { row } = await createDocumentFromStream(
      { orgId: other.orgId, applicationId: other.defaultAppId },
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
      prompt: `Read ${documentUri(row.id)} and summarise it.`,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ProblemBody;
    expect(body.errors?.[0]?.code).toBe("document_uri_in_prompt");
    expect(await shadowRows()).toHaveLength(0);
  });
});
