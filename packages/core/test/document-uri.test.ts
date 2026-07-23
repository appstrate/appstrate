// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the `document://` URI helpers — focused on
 * {@link extractDocumentIdsFromText} (prose-scanning) and a regression guard
 * that {@link extractDocumentIds} keeps matching only whole-string leaf values
 * inside structured JSON (objects/arrays), never scanning embedded prose.
 */

import { describe, it, expect } from "bun:test";
import { extractDocumentIds, extractDocumentIdsFromText } from "../src/document-uri.ts";

const A = "doc_aaaaaaaa";
const B = "doc_bbbbbbbb";

describe("extractDocumentIdsFromText", () => {
  it("finds a document:// URI embedded in surrounding prose", () => {
    expect(extractDocumentIdsFromText(`Please read document://${A} carefully.`)).toEqual([A]);
  });

  it("finds every distinct URI in a text blob, insertion-order stable", () => {
    const text = `Images: document://${A} and then document://${B}. Go.`;
    expect(extractDocumentIdsFromText(text)).toEqual([A, B]);
  });

  it("de-duplicates a repeated URI", () => {
    const text = `document://${A} ... reference document://${A} again`;
    expect(extractDocumentIdsFromText(text)).toEqual([A]);
  });

  it("skips a malformed candidate whose id is too short", () => {
    expect(extractDocumentIdsFromText("see document://doc_bad here")).toEqual([]);
  });

  it("keeps a valid URI even when a malformed one is present", () => {
    expect(extractDocumentIdsFromText(`document://doc_bad and document://${A}`)).toEqual([A]);
  });

  it("returns [] for text with no document:// URIs", () => {
    expect(extractDocumentIdsFromText("summarise the latest emails")).toEqual([]);
  });

  it("returns [] for an empty or non-string input", () => {
    expect(extractDocumentIdsFromText("")).toEqual([]);
    expect(extractDocumentIdsFromText(undefined as unknown as string)).toEqual([]);
  });

  it("stops the id at a non-id character (URI immediately followed by punctuation)", () => {
    expect(extractDocumentIdsFromText(`the file (document://${A}) is attached`)).toEqual([A]);
  });
});

describe("extractDocumentIds — unchanged whole-string behavior on structured input", () => {
  it("collects ids from bare-URI leaf values in objects and arrays", () => {
    const input = { file: `document://${A}`, images: [`document://${B}`] };
    expect(extractDocumentIds(input)).toEqual([A, B]);
  });

  it("does NOT scan document:// URIs embedded inside a longer leaf string", () => {
    // A structured value whose string leaf merely mentions a URI in prose is
    // not a document reference — only the prose-scanning helper matches those.
    expect(extractDocumentIds({ note: `see document://${A} in the notes` })).toEqual([]);
  });
});
