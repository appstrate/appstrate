// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the reserved context-documents field (fan-in by reference).
 *
 * Covers the ONE synthesis helper both entry paths share — the explicit
 * `context_documents` argument and the auto-repair of prompt-named URIs — plus
 * the reserved-name guard and the URI normalizer. No DB: the repair's ACL probe
 * is injected (`canRead`), which is also how the route keeps the ACL as the
 * single authority on who may read what.
 */

import { describe, it, expect } from "bun:test";
import {
  CONTEXT_DOCUMENTS_FIELD,
  assertContextDocumentsFieldAvailable,
  injectContextDocuments,
  normalizeContextDocumentUris,
  resolvePromptDocumentsForContext,
} from "../../src/services/inline-run.ts";
import { collectMountedDocumentIds } from "../../src/services/input-parser.ts";
import { ApiError } from "../../src/lib/errors.ts";
import { isFileField, asJSONSchemaObject, type JSONSchemaObject } from "@appstrate/core/form";
import type { AgentManifest } from "../../src/types/index.ts";

const DOC_A_ID = "doc_aaaaaaaa";
const DOC_B_ID = "doc_bbbbbbbb";
const DOC_A = `document://${DOC_A_ID}`;
const DOC_B = `document://${DOC_B_ID}`;

function manifest(input?: Record<string, unknown>): AgentManifest {
  return {
    name: "@inline/r-test",
    display_name: "Test",
    version: "0.0.0",
    type: "agent",
    schema_version: "0.1",
    ...(input ? { input } : {}),
  } as unknown as AgentManifest;
}

const FILE_SCHEMA = {
  type: "object",
  properties: {
    file: { type: "string", format: "uri", contentMediaType: "application/pdf" },
    note: { type: "string" },
  },
} as unknown as JSONSchemaObject;

const alwaysReadable = async (): Promise<boolean> => true;
const neverReadable = async (): Promise<boolean> => false;

describe("assertContextDocumentsFieldAvailable", () => {
  it("passes for a manifest that does not use the reserved name", () => {
    expect(() =>
      assertContextDocumentsFieldAvailable(manifest({ schema: FILE_SCHEMA }), { file: DOC_A }),
    ).not.toThrow();
  });

  it("rejects a caller manifest that already declares the reserved field", () => {
    let caught: unknown;
    try {
      assertContextDocumentsFieldAvailable(
        manifest({
          schema: {
            type: "object",
            properties: { [CONTEXT_DOCUMENTS_FIELD]: { type: "string" } },
          },
        }),
        undefined,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(400);
    expect((caught as ApiError).message).toContain(CONTEXT_DOCUMENTS_FIELD);
  });

  it("rejects a caller input that already carries the reserved field", () => {
    expect(() =>
      assertContextDocumentsFieldAvailable(manifest(), { [CONTEXT_DOCUMENTS_FIELD]: [DOC_A] }),
    ).toThrow(ApiError);
  });

  it("tolerates a malformed manifest (shape validation is the preflight's job)", () => {
    expect(() => assertContextDocumentsFieldAvailable("not-an-object", null)).not.toThrow();
    expect(() => assertContextDocumentsFieldAvailable(null, null)).not.toThrow();
  });
});

describe("normalizeContextDocumentUris", () => {
  it("returns [] for an absent argument", () => {
    expect(normalizeContextDocumentUris(undefined)).toEqual([]);
    expect(normalizeContextDocumentUris(null)).toEqual([]);
  });

  it("passes document:// URIs through", () => {
    expect(normalizeContextDocumentUris([DOC_A, DOC_B])).toEqual([DOC_A, DOC_B]);
  });

  it("rejects a non-array argument", () => {
    expect(() => normalizeContextDocumentUris(DOC_A)).toThrow(ApiError);
  });

  it("rejects entries that are not document:// URIs", () => {
    expect(() => normalizeContextDocumentUris(["upload://upl_1"])).toThrow(ApiError);
    expect(() => normalizeContextDocumentUris(["https://example.com/a.pdf"])).toThrow(ApiError);
    expect(() => normalizeContextDocumentUris([42])).toThrow(ApiError);
  });
});

describe("injectContextDocuments", () => {
  it("is a no-op when there is nothing to mount", () => {
    const m = manifest({ schema: FILE_SCHEMA });
    const result = injectContextDocuments(m, []);
    expect(result.manifest).toBe(m);
    expect(result.inputPatch).toBeUndefined();
  });

  it("declares a FILE field the normal file-ref path picks up", () => {
    const { manifest: next, inputPatch } = injectContextDocuments(manifest(), [DOC_A, DOC_B]);
    const schema = asJSONSchemaObject(next.input!.schema);
    const property = schema.properties![CONTEXT_DOCUMENTS_FIELD]!;

    // The single fact everything else rests on: the synthesized property is a
    // file field for the SHARED predicate, so `collectFileRefs` streams it, the
    // ACL gates it, and the prompt announces it — no side path.
    expect(isFileField(property)).toBe(true);
    expect(collectMountedDocumentIds(schema, inputPatch)).toEqual(new Set([DOC_A_ID, DOC_B_ID]));
  });

  it("uses a wildcard media range so a heterogeneous fan-in is legal", () => {
    const { manifest: next } = injectContextDocuments(manifest(), [DOC_A]);
    const schema = asJSONSchemaObject(next.input!.schema);
    const property = schema.properties![CONTEXT_DOCUMENTS_FIELD] as unknown as {
      type: string;
      items: { contentMediaType: string; format: string };
    };
    expect(property.type).toBe("array");
    expect(property.items.format).toBe("uri");
    expect(property.items.contentMediaType).toBe("*/*");
  });

  it("preserves the caller's own input properties", () => {
    const { manifest: next } = injectContextDocuments(manifest({ schema: FILE_SCHEMA }), [DOC_A]);
    const schema = asJSONSchemaObject(next.input!.schema);
    expect(Object.keys(schema.properties!).sort()).toEqual([
      CONTEXT_DOCUMENTS_FIELD,
      "file",
      "note",
    ]);
  });

  it("does not mutate the caller's manifest", () => {
    const m = manifest({ schema: FILE_SCHEMA });
    injectContextDocuments(m, [DOC_A]);
    expect(Object.keys(asJSONSchemaObject(m.input!.schema).properties!)).not.toContain(
      CONTEXT_DOCUMENTS_FIELD,
    );
  });

  it("dedupes the same document reached through both entry paths", () => {
    const { inputPatch } = injectContextDocuments(manifest(), [DOC_A, DOC_A, DOC_B]);
    expect(inputPatch![CONTEXT_DOCUMENTS_FIELD]).toEqual([DOC_A, DOC_B]);
  });
});

describe("resolvePromptDocumentsForContext (auto-repair)", () => {
  it("returns nothing — and never probes the ACL — when the prompt names no document", async () => {
    let probes = 0;
    const uris = await resolvePromptDocumentsForContext({
      prompt: "Summarise the user's recent emails.",
      input: null,
      inputSchema: undefined,
      canRead: async () => {
        probes++;
        return true;
      },
    });
    expect(uris).toEqual([]);
    expect(probes).toBe(0);
  });

  it("returns nothing when the prompt URI is already mounted by a declared field", async () => {
    const uris = await resolvePromptDocumentsForContext({
      prompt: `Read ${DOC_A}`,
      input: { file: DOC_A },
      inputSchema: FILE_SCHEMA,
      canRead: alwaysReadable,
    });
    expect(uris).toEqual([]);
  });

  it("repairs an uncovered prompt URI the actor may read", async () => {
    const uris = await resolvePromptDocumentsForContext({
      prompt: `Compile ${DOC_A} and ${DOC_B} into one report.`,
      input: null,
      inputSchema: undefined,
      canRead: alwaysReadable,
    });
    expect(uris).toEqual([DOC_A, DOC_B]);
  });

  it("repairs a URI dropped into a NON-file input field (inert there)", async () => {
    const uris = await resolvePromptDocumentsForContext({
      prompt: `Read ${DOC_A}`,
      input: { note: DOC_A },
      inputSchema: FILE_SCHEMA,
      canRead: alwaysReadable,
    });
    expect(uris).toEqual([DOC_A]);
  });

  it("keeps the recoverable 400 when the document does not resolve for the actor", async () => {
    let caught: unknown;
    try {
      await resolvePromptDocumentsForContext({
        prompt: `Read ${DOC_A}`,
        input: null,
        inputSchema: undefined,
        canRead: neverReadable,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).fieldErrors?.[0]?.code).toBe("document_uri_in_prompt");
    expect((caught as ApiError).fieldErrors?.[0]?.message).toContain(DOC_A);
  });

  it("names only the unresolvable document when the prompt mixes both", async () => {
    let caught: unknown;
    try {
      await resolvePromptDocumentsForContext({
        prompt: `Merge ${DOC_A} with ${DOC_B}`,
        input: null,
        inputSchema: undefined,
        canRead: async (id) => id === DOC_A_ID,
      });
    } catch (err) {
      caught = err;
    }
    const message = (caught as ApiError).fieldErrors?.[0]?.message ?? "";
    expect(message).toContain(DOC_B);
    expect(message).not.toContain(DOC_A);
  });
});
