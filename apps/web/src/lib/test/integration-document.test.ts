// SPDX-License-Identifier: Apache-2.0

/**
 * The integration editor's `content`: what it reads as INTEGRATION.md, and
 * what it sends back. The payload is pinned because the typed client checks
 * its shape, not whether the column is about to hold docs or a manifest copy.
 */
import { describe, expect, test } from "bun:test";
import { integrationDocument, integrationWireContent } from "../integration-document";

describe("integrationDocument", () => {
  test("reads a real document as it is", () => {
    expect(integrationDocument("# Google Drive\n\nUsage notes.")).toBe(
      "# Google Drive\n\nUsage notes.",
    );
  });

  test("reads the manifest fallback, or nothing, as no document", () => {
    expect(integrationDocument('{\n  "name": "@tractr/x"\n}\n')).toBe("");
    expect(integrationDocument(null)).toBe("");
    expect(integrationDocument(undefined)).toBe("");
  });
});

describe("integrationWireContent", () => {
  const manifest = { name: "@tractr/x", version: "1.0.0" };

  test("sends the document when there is one", () => {
    expect(integrationWireContent(manifest, "# Docs")).toBe("# Docs");
  });

  test("sends the manifest text when the document is empty", () => {
    expect(integrationWireContent(manifest, "  \n")).toBe(JSON.stringify(manifest, null, 2));
  });
});
