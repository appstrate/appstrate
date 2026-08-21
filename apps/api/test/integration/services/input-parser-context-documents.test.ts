// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the reserved context-documents field END TO END through
 * `parseRequestInput` — the proof that declaring the field is ALL the work:
 * from there the URIs travel the ordinary file-ref path (container ACL, byte +
 * count caps, streaming into `documents/`, `document_links` consumption).
 *
 * Drives the parser directly with a minimal fake Hono context (same harness as
 * `input-parser-stream.test.ts`) so no run pipeline, Docker or LLM is involved.
 * Real Postgres + FS storage.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import type { Context } from "hono";
import { db } from "@appstrate/db/client";
import { runs } from "@appstrate/db/schema";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext } from "../../helpers/auth.ts";
import { parseRequestInput } from "../../../src/services/input-parser.ts";
import { createDocumentFromStream } from "../../../src/services/documents.ts";
import {
  CONTEXT_DOCUMENTS_FIELD,
  injectContextDocuments,
} from "../../../src/services/inline-run.ts";
import { downloadRunDocumentStream } from "../../../src/services/run-workspace-storage.ts";
import { asJSONSchemaObject } from "@appstrate/core/form";
import { documentUri } from "@appstrate/core/document-uri";
import type { AgentManifest } from "../../../src/types/index.ts";

interface Scope {
  orgId: string;
  applicationId: string;
}

function fakeCtx(scope: Scope, userId: string): Context {
  return {
    get: (key: string) =>
      key === "orgId"
        ? scope.orgId
        : key === "applicationId"
          ? scope.applicationId
          : key === "user"
            ? { id: userId }
            : undefined,
  } as unknown as Context;
}

function inlineManifest(): AgentManifest {
  return {
    name: "@inline/r-ctx",
    display_name: "Ctx",
    version: "0.0.0",
    type: "agent",
    schema_version: "0.1",
  } as unknown as AgentManifest;
}

/** A sibling run's published deliverable: an `agent_output` document. */
async function seedRunDocument(
  scope: Scope,
  opts: { name: string; mime: string; content: string },
): Promise<string> {
  const runId = `run_${crypto.randomUUID()}`;
  await db.insert(runs).values({
    id: runId,
    orgId: scope.orgId,
    applicationId: scope.applicationId,
    packageId: null,
    status: "success",
  });
  const { row } = await createDocumentFromStream(
    scope,
    runId,
    { userId: null, endUserId: null },
    null,
    {
      name: opts.name,
      mime: opts.mime,
      body: new Blob([new TextEncoder().encode(opts.content)]).stream(),
    },
  );
  return row.id;
}

describe("parseRequestInput — reserved context-documents field", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("streams every context document into the run workspace (heterogeneous mimes)", async () => {
    const ctx = await createTestContext({ orgSlug: "ctxdocs-ok" });
    const scope: Scope = { orgId: ctx.orgId, applicationId: ctx.defaultAppId };
    const jsonId = await seedRunDocument(scope, {
      name: "research.json",
      mime: "application/json",
      content: '{"finding":"x"}',
    });
    const mdId = await seedRunDocument(scope, {
      name: "report.md",
      mime: "text/markdown",
      content: "# Report",
    });

    const { manifest, inputPatch } = injectContextDocuments(inlineManifest(), [
      documentUri(jsonId),
      documentUri(mdId),
    ]);
    const runId = `run_${crypto.randomUUID()}`;
    const parsed = await parseRequestInput(
      fakeCtx(scope, ctx.user.id),
      {},
      runId,
      asJSONSchemaObject(manifest.input!.schema),
      { injectedInput: inputPatch },
    );

    // Announced: the file metadata the prompt builder renders as
    // `./documents/<workspaceName>` lines.
    expect(parsed.uploadedFiles).toHaveLength(2);
    expect(parsed.uploadedFiles!.map((f) => f.name).sort()).toEqual(["report.md", "research.json"]);
    expect(parsed.uploadedFiles!.every((f) => f.fieldName === CONTEXT_DOCUMENTS_FIELD)).toBe(true);

    // Mounted: the bytes really landed in the run workspace.
    const stream = await downloadRunDocumentStream(runId, "research.json");
    expect(stream).not.toBeNull();
    expect(await new Response(stream!).text()).toBe('{"finding":"x"}');

    // Chained: every document is registered for a `document_links` row, which
    // `createRun` writes in the same transaction as the run.
    expect(parsed.consumedDocumentIds!.sort()).toEqual([jsonId, mdId].sort());

    // The URIs are persisted on the run input under the reserved field.
    expect(parsed.input![CONTEXT_DOCUMENTS_FIELD]).toEqual([
      documentUri(jsonId),
      documentUri(mdId),
    ]);
  });

  /**
   * The copies run through `mapWithConcurrency` (same bounded pool as the
   * upload path), so more documents than the pool width is the case that would
   * expose a concurrency bug: results landing out of order would pair a
   * document with ANOTHER document's workspace name, and the run would read the
   * wrong bytes under the name the prompt announces.
   *
   * Deliberately more documents than `DOC_STREAM_CONCURRENCY` (4), and every
   * document holds its own index in its bytes so a swap is detectable.
   */
  it("materializes more documents than the concurrency limit, each under its own name", async () => {
    const ctx = await createTestContext({ orgSlug: "ctxdocs-many" });
    const scope: Scope = { orgId: ctx.orgId, applicationId: ctx.defaultAppId };

    const COUNT = 9;
    const ids: string[] = [];
    for (let i = 0; i < COUNT; i++) {
      ids.push(
        await seedRunDocument(scope, {
          name: `doc-${i}.txt`,
          mime: "text/plain",
          content: `content-${i}`,
        }),
      );
    }

    const { manifest, inputPatch } = injectContextDocuments(
      inlineManifest(),
      ids.map((id) => documentUri(id)),
    );
    const runId = `run_${crypto.randomUUID()}`;
    const parsed = await parseRequestInput(
      fakeCtx(scope, ctx.user.id),
      {},
      runId,
      asJSONSchemaObject(manifest.input!.schema),
      { injectedInput: inputPatch },
    );

    expect(parsed.uploadedFiles).toHaveLength(COUNT);
    // Order is the INPUT order, not completion order — the announced file list
    // and the persisted URI list have to line up index for index.
    expect(parsed.uploadedFiles!.map((f) => f.name)).toEqual(
      Array.from({ length: COUNT }, (_, i) => `doc-${i}.txt`),
    );
    expect(parsed.input![CONTEXT_DOCUMENTS_FIELD]).toEqual(ids.map((id) => documentUri(id)));

    // Every file's BYTES sit under its own workspace name — the assertion a
    // mis-paired index would fail even though all the counts still matched.
    for (const file of parsed.uploadedFiles!) {
      const stream = await downloadRunDocumentStream(runId, file.workspaceName);
      expect(stream).not.toBeNull();
      const expected = `content-${file.name.slice("doc-".length, -".txt".length)}`;
      expect(await new Response(stream!).text()).toBe(expected);
    }

    expect(parsed.consumedDocumentIds!.sort()).toEqual([...ids].sort());
  });

  it("refuses a document from another application (container ACL preserved)", async () => {
    const owner = await createTestContext({ orgSlug: "ctxdocs-owner" });
    const other = await createTestContext({ orgSlug: "ctxdocs-other" });
    const foreignId = await seedRunDocument(
      { orgId: owner.orgId, applicationId: owner.defaultAppId },
      { name: "secret.md", mime: "text/markdown", content: "classified" },
    );

    const { manifest, inputPatch } = injectContextDocuments(inlineManifest(), [
      documentUri(foreignId),
    ]);
    const runId = `run_${crypto.randomUUID()}`;
    await expect(
      parseRequestInput(
        fakeCtx({ orgId: other.orgId, applicationId: other.defaultAppId }, other.user.id),
        {},
        runId,
        asJSONSchemaObject(manifest.input!.schema),
        { injectedInput: inputPatch },
      ),
    ).rejects.toMatchObject({ status: 404 });

    // Nothing leaked into the requester's workspace.
    expect(await downloadRunDocumentStream(runId, "secret.md")).toBeNull();
  });

  it("refuses an unknown document id", async () => {
    const ctx = await createTestContext({ orgSlug: "ctxdocs-missing" });
    const { manifest, inputPatch } = injectContextDocuments(inlineManifest(), [
      "document://doc_00000000-0000-0000-0000-000000000000",
    ]);
    await expect(
      parseRequestInput(
        fakeCtx({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, ctx.user.id),
        {},
        `run_${crypto.randomUUID()}`,
        asJSONSchemaObject(manifest.input!.schema),
        { injectedInput: inputPatch },
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
});
