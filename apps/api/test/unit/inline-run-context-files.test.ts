// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the reserved context-files field (fan-in by reference).
 *
 * Covers the synthesis helper behind the explicit `context_files` argument,
 * plus the reserved-name guard and the URI normalizer. No DB — all pure.
 */

import { describe, it, expect } from "bun:test";
import {
  CONTEXT_FILES_FIELD,
  assertContextFilesFieldAvailable,
  injectContextFiles,
  normalizeContextFileUris,
} from "../../src/services/inline-run.ts";
import { collectMountedFileIds } from "../../src/services/input-parser.ts";
import { ApiError } from "../../src/lib/errors.ts";
import { isFileField, asJSONSchemaObject, type JSONSchemaObject } from "@appstrate/core/form";
import type { AgentManifest } from "../../src/types/index.ts";

const DOC_A_ID = "doc_aaaaaaaa";
const DOC_B_ID = "doc_bbbbbbbb";
const DOC_A = `appfile://${DOC_A_ID}`;
const DOC_B = `appfile://${DOC_B_ID}`;

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

describe("assertContextFilesFieldAvailable", () => {
  it("passes for a manifest that does not use the reserved name", () => {
    expect(() =>
      assertContextFilesFieldAvailable(manifest({ schema: FILE_SCHEMA }), { file: DOC_A }),
    ).not.toThrow();
  });

  it("rejects a caller manifest that already declares the reserved field", () => {
    let caught: unknown;
    try {
      assertContextFilesFieldAvailable(
        manifest({
          schema: {
            type: "object",
            properties: { [CONTEXT_FILES_FIELD]: { type: "string" } },
          },
        }),
        undefined,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(400);
    expect((caught as ApiError).message).toContain(CONTEXT_FILES_FIELD);
  });

  it("rejects a caller input that already carries the reserved field", () => {
    expect(() =>
      assertContextFilesFieldAvailable(manifest(), { [CONTEXT_FILES_FIELD]: [DOC_A] }),
    ).toThrow(ApiError);
  });

  it("tolerates a malformed manifest (shape validation is the preflight's job)", () => {
    expect(() => assertContextFilesFieldAvailable("not-an-object", null)).not.toThrow();
    expect(() => assertContextFilesFieldAvailable(null, null)).not.toThrow();
  });
});

describe("normalizeContextFileUris", () => {
  it("returns [] for an absent argument", () => {
    expect(normalizeContextFileUris(undefined)).toEqual([]);
    expect(normalizeContextFileUris(null)).toEqual([]);
  });

  it("passes appfile:// URIs through", () => {
    expect(normalizeContextFileUris([DOC_A, DOC_B])).toEqual([DOC_A, DOC_B]);
  });

  it("rejects a non-array argument", () => {
    expect(() => normalizeContextFileUris(DOC_A)).toThrow(ApiError);
  });

  it("rejects entries that are not appfile:// URIs", () => {
    expect(() => normalizeContextFileUris(["upload://upl_1"])).toThrow(ApiError);
    expect(() => normalizeContextFileUris(["https://example.com/a.pdf"])).toThrow(ApiError);
    expect(() => normalizeContextFileUris([42])).toThrow(ApiError);
  });
});

describe("injectContextFiles", () => {
  it("is a no-op when there is nothing to mount", () => {
    const m = manifest({ schema: FILE_SCHEMA });
    const result = injectContextFiles(m, []);
    expect(result.manifest).toBe(m);
    expect(result.inputPatch).toBeUndefined();
  });

  it("declares a FILE field the normal file-ref path picks up", () => {
    const { manifest: next, inputPatch } = injectContextFiles(manifest(), [DOC_A, DOC_B]);
    const schema = asJSONSchemaObject(next.input!.schema);
    const property = schema.properties![CONTEXT_FILES_FIELD]!;

    // The single fact everything else rests on: the synthesized property is a
    // file field for the SHARED predicate, so `collectFileRefs` streams it, the
    // ACL gates it, and the prompt announces it — no side path.
    expect(isFileField(property)).toBe(true);
    expect(collectMountedFileIds(schema, inputPatch)).toEqual(new Set([DOC_A_ID, DOC_B_ID]));
  });

  it("uses a wildcard media range so a heterogeneous fan-in is legal", () => {
    const { manifest: next } = injectContextFiles(manifest(), [DOC_A]);
    const schema = asJSONSchemaObject(next.input!.schema);
    const property = schema.properties![CONTEXT_FILES_FIELD] as unknown as {
      type: string;
      items: { contentMediaType: string; format: string };
    };
    expect(property.type).toBe("array");
    expect(property.items.format).toBe("uri");
    expect(property.items.contentMediaType).toBe("*/*");
  });

  it("preserves the caller's own input properties", () => {
    const { manifest: next } = injectContextFiles(manifest({ schema: FILE_SCHEMA }), [DOC_A]);
    const schema = asJSONSchemaObject(next.input!.schema);
    expect(Object.keys(schema.properties!).sort()).toEqual([CONTEXT_FILES_FIELD, "file", "note"]);
  });

  it("does not mutate the caller's manifest", () => {
    const m = manifest({ schema: FILE_SCHEMA });
    injectContextFiles(m, [DOC_A]);
    expect(Object.keys(asJSONSchemaObject(m.input!.schema).properties!)).not.toContain(
      CONTEXT_FILES_FIELD,
    );
  });

  it("dedupes the same file reached through both entry paths", () => {
    const { inputPatch } = injectContextFiles(manifest(), [DOC_A, DOC_A, DOC_B]);
    expect(inputPatch![CONTEXT_FILES_FIELD]).toEqual([DOC_A, DOC_B]);
  });
});
