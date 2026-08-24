// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the stored-file URI helpers — focused on
 * {@link extractFileIdsFromText} (prose-scanning), a regression guard that
 * {@link extractFileIds} keeps matching only whole-string leaf values inside
 * structured JSON (objects/arrays) and never scans embedded prose, and the
 * single-scheme contract: `appfile://` is the only spelling written AND the
 * only one read. The pre-#1177 `document://` scheme is refused, which the last
 * block below pins from both sides — a `doc_` id fails, and so does the
 * `document://file_…` pairing that no build has ever emitted.
 */

import { describe, it, expect } from "bun:test";
import {
  FILE_URI_PREFIX,
  extractFileIds,
  extractFileIdsFromText,
  fileUri,
  isAttachmentUri,
  isFileUri,
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

  it("parseFileUri refuses the retired document:// scheme", () => {
    expect(parseFileUri(`appfile://${A}`)).toBe(A);
    // The only form the retired accept-path could still have matched, and no
    // build ever emitted it: `document://` was replaced by `appfile://` in the
    // same issue that eventually re-minted the id prefix to `file_`.
    expect(parseFileUri(`document://${A}`)).toBeNull();
    // The form that WAS written under the old scheme fails on the id, which is
    // why the prefix had nothing left to address.
    expect(parseFileUri("document://doc_aaaaaaaa")).toBeNull();
    expect(parseFileUri("appfile://doc_aaaaaaaa")).toBeNull();
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
