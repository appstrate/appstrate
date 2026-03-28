/**
 * Tests that file field detection and validation use standard JSON Schema
 * conventions (format:"uri" + contentMediaType) and never rely on type:"file".
 */

import { describe, it, expect } from "bun:test";
import {
  isFileField,
  isMultipleFileField,
  type JSONSchema7,
  type JSONSchemaObject,
} from "@appstrate/core/form";
import {
  schemaHasFileFields,
  validateFileInputs,
  parseFormDataFiles,
} from "../../src/services/schema.ts";

// --- isFileField / isMultipleFileField ---

describe("isFileField", () => {
  it("detects single file field (string + uri + contentMediaType)", () => {
    const prop: JSONSchema7 = {
      type: "string",
      format: "uri",
      contentMediaType: "application/octet-stream",
    };
    expect(isFileField(prop)).toBe(true);
    expect(isMultipleFileField(prop)).toBe(false);
  });

  it("detects multiple file field (array + items with uri + contentMediaType)", () => {
    const prop: JSONSchema7 = {
      type: "array",
      items: { type: "string", format: "uri", contentMediaType: "application/pdf" },
      maxItems: 5,
    };
    expect(isFileField(prop)).toBe(true);
    expect(isMultipleFileField(prop)).toBe(true);
  });

  it("rejects plain string field", () => {
    expect(isFileField({ type: "string" })).toBe(false);
  });

  it("rejects string with format:uri but no contentMediaType", () => {
    expect(isFileField({ type: "string", format: "uri" })).toBe(false);
  });

  it("rejects string with contentMediaType but no format:uri", () => {
    expect(isFileField({ type: "string", contentMediaType: "application/pdf" })).toBe(false);
  });

  it("rejects array without file items", () => {
    expect(isFileField({ type: "array", items: { type: "string" } })).toBe(false);
  });

  it("rejects old type:'file' convention", () => {
    expect(isFileField({ type: "file" } as unknown as JSONSchema7)).toBe(false);
  });

  it("rejects number, boolean, object types", () => {
    expect(isFileField({ type: "number" })).toBe(false);
    expect(isFileField({ type: "boolean" })).toBe(false);
    expect(isFileField({ type: "object" })).toBe(false);
  });
});

// --- schemaHasFileFields ---

describe("schemaHasFileFields", () => {
  it("returns true when schema has a single file field", () => {
    const schema: JSONSchemaObject = {
      type: "object",
      properties: {
        name: { type: "string" },
        doc: { type: "string", format: "uri", contentMediaType: "application/octet-stream" },
      },
    };
    expect(schemaHasFileFields(schema)).toBe(true);
  });

  it("returns true when schema has a multiple file field", () => {
    const schema: JSONSchemaObject = {
      type: "object",
      properties: {
        docs: {
          type: "array",
          items: { type: "string", format: "uri", contentMediaType: "application/octet-stream" },
          maxItems: 3,
        },
      },
    };
    expect(schemaHasFileFields(schema)).toBe(true);
  });

  it("returns false when schema has no file fields", () => {
    const schema: JSONSchemaObject = {
      type: "object",
      properties: {
        name: { type: "string" },
        count: { type: "number" },
      },
    };
    expect(schemaHasFileFields(schema)).toBe(false);
  });

  it("returns false for undefined schema", () => {
    expect(schemaHasFileFields(undefined)).toBe(false);
  });

  it("returns false for old type:'file' (not detected)", () => {
    const schema = {
      type: "object" as const,
      properties: {
        doc: { type: "file" },
      },
    };
    expect(schemaHasFileFields(schema as unknown as JSONSchemaObject)).toBe(false);
  });
});

// --- validateFileInputs ---

describe("validateFileInputs — reads from fileConstraints", () => {
  const schemaWithSingleFile: JSONSchemaObject = {
    type: "object",
    properties: {
      doc: { type: "string", format: "uri", contentMediaType: "application/octet-stream" },
    },
    required: ["doc"],
  };

  const schemaWithMultipleFiles: JSONSchemaObject = {
    type: "object",
    properties: {
      docs: {
        type: "array",
        items: { type: "string", format: "uri", contentMediaType: "application/octet-stream" },
        maxItems: 2,
      },
    },
    required: ["docs"],
  };

  it("rejects when required file is missing", () => {
    const result = validateFileInputs([], schemaWithSingleFile);
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.field).toBe("doc");
  });

  it("accepts when required file is present", () => {
    const files = [{ fieldName: "doc", name: "test.pdf", type: "application/pdf", size: 100, buffer: Buffer.from("") }];
    const result = validateFileInputs(files, schemaWithSingleFile);
    expect(result.valid).toBe(true);
  });

  it("rejects multiple files for single-file field", () => {
    const files = [
      { fieldName: "doc", name: "a.pdf", type: "application/pdf", size: 100, buffer: Buffer.from("") },
      { fieldName: "doc", name: "b.pdf", type: "application/pdf", size: 100, buffer: Buffer.from("") },
    ];
    const result = validateFileInputs(files, schemaWithSingleFile);
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.message).toContain("only one file");
  });

  it("enforces maxItems from schema as maxFiles for array fields", () => {
    const files = [
      { fieldName: "docs", name: "a.pdf", type: "application/pdf", size: 100, buffer: Buffer.from("") },
      { fieldName: "docs", name: "b.pdf", type: "application/pdf", size: 100, buffer: Buffer.from("") },
      { fieldName: "docs", name: "c.pdf", type: "application/pdf", size: 100, buffer: Buffer.from("") },
    ];
    const result = validateFileInputs(files, schemaWithMultipleFiles);
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.message).toContain("at most 2");
  });

  it("reads accept constraint from fileConstraints param", () => {
    const files = [{ fieldName: "doc", name: "test.txt", type: "text/plain", size: 100, buffer: Buffer.from("") }];
    const result = validateFileInputs(files, schemaWithSingleFile, {
      doc: { accept: ".pdf,.docx" },
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.message).toContain("disallowed extension");
  });

  it("reads maxSize constraint from fileConstraints param", () => {
    const files = [{ fieldName: "doc", name: "big.pdf", type: "application/pdf", size: 20_000_000, buffer: Buffer.from("") }];
    const result = validateFileInputs(files, schemaWithSingleFile, {
      doc: { maxSize: 10_485_760 },
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.message).toContain("exceeds max size");
  });

  it("passes when fileConstraints are absent (no restrictions)", () => {
    const files = [{ fieldName: "doc", name: "anything.xyz", type: "application/xyz", size: 999_999_999, buffer: Buffer.from("") }];
    const result = validateFileInputs(files, schemaWithSingleFile);
    expect(result.valid).toBe(true);
  });
});

// --- parseFormDataFiles ---

describe("parseFormDataFiles — detects file fields via standard JSON Schema", () => {
  it("extracts files from fields with format:uri + contentMediaType", async () => {
    const schema: JSONSchemaObject = {
      type: "object",
      properties: {
        query: { type: "string" },
        doc: { type: "string", format: "uri", contentMediaType: "application/octet-stream" },
      },
    };
    const formData = new FormData();
    formData.set("input", JSON.stringify({ query: "test" }));
    formData.set("doc", new File(["content"], "test.pdf", { type: "application/pdf" }));

    const result = await parseFormDataFiles(formData, schema);
    expect(result.input).toEqual({ query: "test" });
    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.fieldName).toBe("doc");
    expect(result.files[0]!.name).toBe("test.pdf");
  });

  it("does not extract non-file fields as files", async () => {
    const schema: JSONSchemaObject = {
      type: "object",
      properties: {
        name: { type: "string" },
        url: { type: "string", format: "uri" },
      },
    };
    const formData = new FormData();
    formData.set("input", JSON.stringify({ name: "test", url: "https://example.com" }));

    const result = await parseFormDataFiles(formData, schema);
    expect(result.files).toHaveLength(0);
  });
});
