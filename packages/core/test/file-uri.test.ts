// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the stored-file URI helpers — focused on
 * {@link extractFileIdsFromText} (prose-scanning), a regression guard that
 * {@link extractFileIds} keeps matching only whole-string leaf values inside
 * structured JSON (objects/arrays) and never scans embedded prose, and the
 * single-scheme contract: `appfile://` is the only spelling written AND the
 * only one read. The pre-#1177 `document://` SCHEME is refused — but the
 * `doc_` ID it used to address is still live on every production row, and the
 * third and fourth blocks below pin that split in both directions. The last block
 * covers the sibling `upload://` predicate, which every caller of the URI
 * helpers (the API parser, `packages/ui`'s `FileWidget`) shares.
 */

import { describe, it, expect } from "bun:test";
import {
  FILE_URI_PREFIX,
  FILE_ID_RE,
  extractFileIds,
  extractFileIdsFromText,
  fileUri,
  isAttachmentUri,
  isFileUri,
  isUploadUri,
  parseFileUri,
} from "../src/file-uri.ts";

const A = "file_aaaaaaaa";
const B = "file_bbbbbbbb";

describe("extractFileIdsFromText", () => {
  it("finds an appfile:// URI embedded in surrounding prose", () => {
    expect(extractFileIdsFromText(`Please read appfile://${A} carefully.`)).toEqual([A]);
  });

  it("finds every distinct URI in a text blob, insertion-order stable", () => {
    const text = `Images: appfile://${A} and then appfile://${B}. Go.`;
    expect(extractFileIdsFromText(text)).toEqual([A, B]);
  });

  it("de-duplicates a repeated URI", () => {
    const text = `appfile://${A} ... reference appfile://${A} again`;
    expect(extractFileIdsFromText(text)).toEqual([A]);
  });

  it("skips a malformed candidate whose id is too short", () => {
    expect(extractFileIdsFromText("see appfile://file_bad here")).toEqual([]);
  });

  it("keeps a valid URI even when a malformed one is present", () => {
    expect(extractFileIdsFromText(`appfile://file_bad and appfile://${A}`)).toEqual([A]);
  });

  it("returns [] for text with no appfile:// URIs", () => {
    expect(extractFileIdsFromText("summarise the latest emails")).toEqual([]);
  });

  it("returns [] for an empty or non-string input", () => {
    expect(extractFileIdsFromText("")).toEqual([]);
    expect(extractFileIdsFromText(undefined as unknown as string)).toEqual([]);
  });

  it("stops the id at a non-id character (URI immediately followed by punctuation)", () => {
    expect(extractFileIdsFromText(`the file (appfile://${A}) is attached`)).toEqual([A]);
  });
});

describe("extractFileIds — unchanged whole-string behavior on structured input", () => {
  it("collects ids from bare-URI leaf values in objects and arrays", () => {
    const input = { file: `appfile://${A}`, images: [`appfile://${B}`] };
    expect(extractFileIds(input)).toEqual([A, B]);
  });

  it("does NOT scan appfile:// URIs embedded inside a longer leaf string", () => {
    // A structured value whose string leaf merely mentions a URI in prose is
    // not a file reference — only the prose-scanning helper matches those.
    expect(extractFileIds({ note: `see appfile://${A} in the notes` })).toEqual([]);
  });
});

describe("single-scheme contract (#1177)", () => {
  it("fileUri emits appfile:// and only appfile://", () => {
    expect(fileUri(A)).toBe(`${FILE_URI_PREFIX}${A}`);
    expect(fileUri(A)).toBe(`appfile://${A}`);
  });

  it("parseFileUri refuses the retired document:// scheme, on the SCHEME alone", () => {
    expect(parseFileUri(`appfile://${A}`)).toBe(A);
    expect(parseFileUri(`document://${A}`)).toBeNull();
    // The scheme is retired; the `doc_` ID it used to address is NOT. Both of
    // these pin that split, and the second one is the production bug: an
    // earlier revision rejected it, which 404'd every pre-rename file at once
    // because `loadFileForPreview` tests the id regex before any SELECT.
    expect(parseFileUri("document://doc_aaaaaaaa")).toBeNull();
    expect(parseFileUri("appfile://doc_aaaaaaaa")).toBe("doc_aaaaaaaa");
  });

  it("a legacy doc_ id survives every reader on the serving path", () => {
    // 0043 renamed the table and 0044 rewrote storage_key; NEITHER touched
    // files.id. Measured on production the day 0044 shipped: 521 rows `doc_`,
    // 0 rows `file_`. So `doc_` is not a hypothetical — it is every row there.
    const legacy = "doc_31c2435b-a7f8-41da-a82c-3b86ad59f8e6";
    expect(FILE_ID_RE.test(legacy)).toBe(true);
    expect(parseFileUri(fileUri(legacy))).toBe(legacy);
    // The prose scan must see it too: `fileUri` is a bare concatenation, so a
    // legacy row yields `appfile://doc_…`, and a `file_`-only scan would drop
    // it from a prompt while the caller read "not found" as "not referenced".
    expect(extractFileIdsFromText(`see ${fileUri(legacy)} for details`)).toEqual([legacy]);
    expect(extractFileIds({ input: fileUri(legacy) })).toEqual([legacy]);
    // Still minted as `file_`; `doc_` is read-only history, never written.
    expect(FILE_ID_RE.test("file_aaaaaaaa")).toBe(true);
    expect(FILE_ID_RE.test("doc_short")).toBe(false);
    expect(FILE_ID_RE.test("upl_aaaaaaaa")).toBe(false);
  });

  it("parseFileUri still rejects a malformed id and a foreign scheme", () => {
    expect(parseFileUri("appfile://file_bad")).toBeNull();
    expect(parseFileUri(`file://${A}`)).toBeNull();
    expect(parseFileUri(`upload://upl_aaaaaaaa`)).toBeNull();
  });

  it("isFileUri / isAttachmentUri accept appfile:// only", () => {
    expect(isFileUri(`appfile://${A}`)).toBe(true);
    expect(isFileUri(`document://${A}`)).toBe(false);
    expect(isFileUri(`file://${A}`)).toBe(false);
    // `upload://` is an attachment URI but never a stored-file URI: the two
    // predicates deliberately disagree on it, which is the whole reason both
    // exist.
    expect(isFileUri(`upload://upl_aaaaaaaa`)).toBe(false);
    expect(isAttachmentUri(`appfile://${A}`)).toBe(true);
    expect(isAttachmentUri(`document://${A}`)).toBe(false);
    expect(isAttachmentUri(`upload://upl_aaaaaaaa`)).toBe(true);
    expect(isAttachmentUri(`https://example.com/x`)).toBe(false);
  });

  it("extractFileIds and extractFileIdsFromText ignore the retired scheme", () => {
    expect(extractFileIds({ report: `document://${A}`, images: [`document://${B}`] })).toEqual([]);
    expect(extractFileIdsFromText(`old document://${A} and new appfile://${B}`)).toEqual([B]);
  });
});

describe("isUploadUri", () => {
  it("accepts valid upload:// strings", () => {
    expect(isUploadUri("upload://upl_abc")).toBe(true);
  });

  it("rejects other strings", () => {
    expect(isUploadUri("https://example.com/file")).toBe(false);
    expect(isUploadUri("")).toBe(false);
  });

  it("rejects non-string values", () => {
    // `FileWidget` (packages/ui) hands raw form-field values straight in, so the
    // predicate has to survive whatever a schema-driven field holds.
    expect(isUploadUri(null)).toBe(false);
    expect(isUploadUri(undefined)).toBe(false);
    expect(isUploadUri(123)).toBe(false);
    expect(isUploadUri({})).toBe(false);
  });
});
