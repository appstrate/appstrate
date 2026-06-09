// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the pure file-reference collector + inline data: URI parser
 * used by the run-request input parser. Covers the dispatch logic between
 * single-file and array-of-files fields, the upload:// vs data: kind tagging,
 * the error shapes emitted when the client submits the wrong type, and the
 * RFC 2397 decode rules (base64-only, per-file cap, name parameter).
 */

import { describe, it, expect } from "bun:test";
import {
  collectFileRefs,
  parseDataUri,
  assertDocsWithinCap,
  MAX_INLINE_FILE_BYTES,
} from "../../src/services/input-parser.ts";
import { ApiError } from "../../src/lib/errors.ts";
import type { JSONSchemaObject } from "@appstrate/core/form";

const singleFileSchema: JSONSchemaObject = {
  type: "object",
  properties: {
    doc: { type: "string", format: "uri", contentMediaType: "application/pdf" },
    title: { type: "string" },
  },
};

const arrayFileSchema: JSONSchemaObject = {
  type: "object",
  properties: {
    docs: {
      type: "array",
      items: { type: "string", format: "uri", contentMediaType: "application/pdf" },
      maxItems: 5,
    },
  },
};

describe("collectFileRefs — single-file fields", () => {
  it("picks up a valid upload:// URI", () => {
    const refs = collectFileRefs(singleFileSchema, { doc: "upload://upl_abc", title: "t" });
    expect(refs).toEqual([{ fieldName: "doc", uri: "upload://upl_abc", kind: "upload" }]);
  });

  it("picks up an inline data: URI", () => {
    const uri = "data:application/pdf;base64,JVBERg==";
    const refs = collectFileRefs(singleFileSchema, { doc: uri });
    expect(refs).toEqual([{ fieldName: "doc", uri, kind: "data" }]);
  });

  it("ignores the field when the value is null or missing", () => {
    expect(collectFileRefs(singleFileSchema, { title: "t" })).toEqual([]);
    expect(collectFileRefs(singleFileSchema, { doc: null, title: "t" })).toEqual([]);
  });

  it("rejects a non-URI string on a single-file field", () => {
    try {
      collectFileRefs(singleFileSchema, { doc: "just-a-name.pdf" });
      throw new Error("expected to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(400);
      expect((e as ApiError).message).toContain("doc");
    }
  });

  it("rejects an array on a single-file field", () => {
    try {
      collectFileRefs(singleFileSchema, { doc: ["upload://upl_x"] });
      throw new Error("expected to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
    }
  });

  it("skips non-file siblings without inspecting them", () => {
    const refs = collectFileRefs(singleFileSchema, { doc: "upload://upl_1", title: 42 });
    expect(refs).toHaveLength(1);
  });
});

describe("collectFileRefs — array-of-files fields", () => {
  it("emits one indexed ref per URI in order", () => {
    const refs = collectFileRefs(arrayFileSchema, {
      docs: ["upload://upl_1", "upload://upl_2"],
    });
    expect(refs).toEqual([
      { fieldName: "docs", uri: "upload://upl_1", kind: "upload", index: 0 },
      { fieldName: "docs", uri: "upload://upl_2", kind: "upload", index: 1 },
    ]);
  });

  it("supports mixing upload:// and data: entries", () => {
    const dataUri = "data:text/plain;base64,aGVsbG8=";
    const refs = collectFileRefs(arrayFileSchema, {
      docs: ["upload://upl_1", dataUri],
    });
    expect(refs).toEqual([
      { fieldName: "docs", uri: "upload://upl_1", kind: "upload", index: 0 },
      { fieldName: "docs", uri: dataUri, kind: "data", index: 1 },
    ]);
  });

  it("accepts an empty array", () => {
    expect(collectFileRefs(arrayFileSchema, { docs: [] })).toEqual([]);
  });

  it("ignores the field when missing or null", () => {
    expect(collectFileRefs(arrayFileSchema, {})).toEqual([]);
    expect(collectFileRefs(arrayFileSchema, { docs: null })).toEqual([]);
  });

  it("rejects a scalar value on an array field", () => {
    try {
      collectFileRefs(arrayFileSchema, { docs: "upload://upl_x" });
      throw new Error("expected to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).message).toContain("array");
    }
  });

  it("rejects any non-URI entry inside the array", () => {
    try {
      collectFileRefs(arrayFileSchema, {
        docs: ["upload://upl_1", "not-a-uri"],
      });
      throw new Error("expected to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).message).toContain("docs");
    }
  });
});

describe("parseDataUri", () => {
  it("decodes a base64 data URI with mime + name", () => {
    const file = parseDataUri("data:application/pdf;name=invoice.pdf;base64,JVBERg==", "doc");
    expect(file.mime).toBe("application/pdf");
    expect(file.name).toBe("invoice.pdf");
    expect(Buffer.from(file.bytes).toString("utf-8")).toBe("%PDF");
  });

  it("decodes a URI-escaped name parameter", () => {
    const file = parseDataUri("data:text/plain;name=my%20notes.txt;base64,aGk=", "doc");
    expect(file.name).toBe("my notes.txt");
  });

  it("defaults the mediatype to text/plain and normalizes parameters", () => {
    expect(parseDataUri("data:;base64,aGk=", "doc").mime).toBe("text/plain");
    expect(parseDataUri("data:Text/Plain;charset=utf-8;base64,aGk=", "doc").mime).toBe(
      "text/plain",
    );
  });

  it("rejects a non-base64 (URL-encoded) data URI", () => {
    try {
      parseDataUri("data:text/plain,hello%20world", "doc");
      throw new Error("expected to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(400);
      expect((e as ApiError).message).toContain("base64");
    }
  });

  it("rejects a URI without the ',' separator", () => {
    try {
      parseDataUri("data:application/pdf;base64", "doc");
      throw new Error("expected to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(400);
    }
  });

  it("rejects an invalid base64 payload", () => {
    try {
      parseDataUri("data:text/plain;base64,no spaces!", "doc");
      throw new Error("expected to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(400);
      expect((e as ApiError).message).toContain("base64");
    }
  });

  it("rejects an empty payload", () => {
    try {
      parseDataUri("data:text/plain;base64,", "doc");
      throw new Error("expected to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(400);
      expect((e as ApiError).message).toContain("empty");
    }
  });

  it("throws 413 when the decoded payload exceeds the per-file cap", () => {
    // Base64 string longer than the pre-decode ceiling — rejected without decoding.
    const oversized = "A".repeat(Math.ceil(MAX_INLINE_FILE_BYTES / 3) * 4 + 4);
    try {
      parseDataUri(`data:application/octet-stream;base64,${oversized}`, "doc");
      throw new Error("expected to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(413);
      expect((e as ApiError).message).toContain("createUpload");
    }
  });

  it("accepts a payload exactly at the cap boundary", () => {
    const exact = Buffer.alloc(MAX_INLINE_FILE_BYTES, 0x61).toString("base64");
    const file = parseDataUri(`data:application/octet-stream;base64,${exact}`, "doc");
    expect(file.bytes.byteLength).toBe(MAX_INLINE_FILE_BYTES);
  });
});

describe("assertDocsWithinCap", () => {
  it("passes when the total is under the cap", () => {
    expect(() => assertDocsWithinCap([{ size: 100 }, { size: 200 }], 1000)).not.toThrow();
  });

  it("passes when the total is exactly the cap (boundary)", () => {
    expect(() => assertDocsWithinCap([{ size: 600 }, { size: 400 }], 1000)).not.toThrow();
  });

  it("passes with no documents", () => {
    expect(() => assertDocsWithinCap([], 1000)).not.toThrow();
  });

  it("throws 413 when the total exceeds the cap", () => {
    try {
      assertDocsWithinCap([{ size: 600 }, { size: 600 }], 1000);
      throw new Error("expected to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(413);
      // Reports both the offending total and the limit for actionable errors.
      expect((e as ApiError).message).toContain("1200");
      expect((e as ApiError).message).toContain("1000");
    }
  });
});

describe("collectFileRefs — schemas without file fields", () => {
  it("returns [] when no property matches the file shape", () => {
    const schema: JSONSchemaObject = {
      type: "object",
      properties: { name: { type: "string" }, count: { type: "number" } },
    };
    expect(collectFileRefs(schema, { name: "x", count: 3 })).toEqual([]);
  });

  it("returns [] for a schema with no properties at all", () => {
    expect(collectFileRefs({ type: "object" } as JSONSchemaObject, {})).toEqual([]);
  });
});
