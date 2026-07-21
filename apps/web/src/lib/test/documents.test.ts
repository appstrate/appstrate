// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { File as FileIcon, FileArchive, FileCode, FileImage, FileText } from "lucide-react";
import {
  documentContentHref,
  documentRunHref,
  groupDocumentsByPurpose,
  mimeIconFor,
  type DocumentLike,
} from "../documents.ts";

function doc(overrides: Partial<DocumentLike>): DocumentLike {
  return {
    purpose: "agent_output",
    run_id: null,
    package_id: null,
    mime: "application/octet-stream",
    ...overrides,
  };
}

describe("mimeIconFor", () => {
  test("maps common families", () => {
    expect(mimeIconFor("image/png")).toBe(FileImage);
    expect(mimeIconFor("text/html")).toBe(FileCode);
    expect(mimeIconFor("application/json")).toBe(FileCode);
    expect(mimeIconFor("application/zip")).toBe(FileArchive);
    expect(mimeIconFor("text/plain")).toBe(FileText);
    expect(mimeIconFor("application/pdf")).toBe(FileText);
  });

  test("falls back to the neutral file icon", () => {
    expect(mimeIconFor("application/octet-stream")).toBe(FileIcon);
    expect(mimeIconFor("")).toBe(FileIcon);
  });
});

describe("groupDocumentsByPurpose", () => {
  test("splits uploads from outputs, preserving order", () => {
    const docs = [
      doc({ purpose: "user_upload", mime: "a" }),
      doc({ purpose: "agent_output", mime: "b" }),
      doc({ purpose: "agent_output", mime: "c" }),
      doc({ purpose: "user_upload", mime: "d" }),
    ];
    const { inputs, outputs } = groupDocumentsByPurpose(docs);
    expect(inputs.map((d) => d.mime)).toEqual(["a", "d"]);
    expect(outputs.map((d) => d.mime)).toEqual(["b", "c"]);
  });

  test("handles an empty list", () => {
    expect(groupDocumentsByPurpose([])).toEqual({ inputs: [], outputs: [] });
  });
});

describe("documentRunHref", () => {
  test("builds the agent run route with literal scope slashes", () => {
    expect(documentRunHref(doc({ run_id: "run_1", package_id: "@acme/writer" }))).toBe(
      "/agents/@acme/writer/runs/run_1",
    );
  });

  test("returns undefined without a run or a package id", () => {
    expect(documentRunHref(doc({ run_id: null, package_id: "@acme/writer" }))).toBeUndefined();
    expect(documentRunHref(doc({ run_id: "run_1", package_id: null }))).toBeUndefined();
  });
});

describe("documentContentHref", () => {
  test("encodes the id into the content route", () => {
    expect(documentContentHref("doc_1")).toBe("/api/documents/doc_1/content");
  });
});
