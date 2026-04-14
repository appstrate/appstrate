// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the pure upload-reference collector used by the run-request
 * input parser. Covers the dispatch logic between single-file and array-of-files
 * fields, plus the error shapes emitted when the client submits the wrong type.
 */

import { describe, it, expect } from "bun:test";
import { collectUploadRefs } from "../../src/services/input-parser.ts";
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

describe("collectUploadRefs — single-file fields", () => {
  it("picks up a valid upload:// URI", () => {
    const refs = collectUploadRefs(singleFileSchema, { doc: "upload://upl_abc", title: "t" });
    expect(refs).toEqual([{ fieldName: "doc", uri: "upload://upl_abc" }]);
  });

  it("ignores the field when the value is null or missing", () => {
    expect(collectUploadRefs(singleFileSchema, { title: "t" })).toEqual([]);
    expect(collectUploadRefs(singleFileSchema, { doc: null, title: "t" })).toEqual([]);
  });

  it("rejects a non-URI string on a single-file field", () => {
    try {
      collectUploadRefs(singleFileSchema, { doc: "just-a-name.pdf" });
      throw new Error("expected to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(400);
      expect((e as ApiError).message).toContain("doc");
    }
  });

  it("rejects an array on a single-file field", () => {
    try {
      collectUploadRefs(singleFileSchema, { doc: ["upload://upl_x"] });
      throw new Error("expected to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
    }
  });

  it("skips non-file siblings without inspecting them", () => {
    const refs = collectUploadRefs(singleFileSchema, { doc: "upload://upl_1", title: 42 });
    expect(refs).toHaveLength(1);
  });
});

describe("collectUploadRefs — array-of-files fields", () => {
  it("emits one ref per URI in order", () => {
    const refs = collectUploadRefs(arrayFileSchema, {
      docs: ["upload://upl_1", "upload://upl_2"],
    });
    expect(refs).toEqual([
      { fieldName: "docs", uri: "upload://upl_1" },
      { fieldName: "docs", uri: "upload://upl_2" },
    ]);
  });

  it("accepts an empty array", () => {
    expect(collectUploadRefs(arrayFileSchema, { docs: [] })).toEqual([]);
  });

  it("ignores the field when missing or null", () => {
    expect(collectUploadRefs(arrayFileSchema, {})).toEqual([]);
    expect(collectUploadRefs(arrayFileSchema, { docs: null })).toEqual([]);
  });

  it("rejects a scalar value on an array field", () => {
    try {
      collectUploadRefs(arrayFileSchema, { docs: "upload://upl_x" });
      throw new Error("expected to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).message).toContain("array");
    }
  });

  it("rejects any non-URI entry inside the array", () => {
    try {
      collectUploadRefs(arrayFileSchema, {
        docs: ["upload://upl_1", "not-a-uri"],
      });
      throw new Error("expected to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).message).toContain("docs");
    }
  });
});

describe("collectUploadRefs — schemas without file fields", () => {
  it("returns [] when no property matches the file shape", () => {
    const schema: JSONSchemaObject = {
      type: "object",
      properties: { name: { type: "string" }, count: { type: "number" } },
    };
    expect(collectUploadRefs(schema, { name: "x", count: 3 })).toEqual([]);
  });

  it("returns [] for a schema with no properties at all", () => {
    expect(collectUploadRefs({ type: "object" } as JSONSchemaObject, {})).toEqual([]);
  });
});
