// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the stored-file URI helpers — focused on
 * {@link extractFileIdsFromText} (prose-scanning), a regression guard that
 * {@link extractFileIds} keeps matching only whole-string leaf values inside
 * structured JSON (objects/arrays) and never scans embedded prose, and the
 * dual-scheme contract: write `appfile://`, read `appfile://` AND the legacy
 * `appfile://` forever (historical `runs.input` rows are full of the latter).
 */

import { describe, it, expect } from "bun:test";
import {
  FILE_URI_PREFIX,
  LEGACY_DOCUMENT_URI_PREFIX,
  extractFileIds,
  extractFileIdsFromText,
  fileUri,
  isAttachmentUri,
  isFileUri,
  parseFileUri,
} from "../src/file-uri.ts";

const A = "doc_aaaaaaaa";
const B = "doc_bbbbbbbb";

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
    expect(extractFileIdsFromText("see appfile://doc_bad here")).toEqual([]);
  });

  it("keeps a valid URI even when a malformed one is present", () => {
    expect(extractFileIdsFromText(`appfile://doc_bad and appfile://${A}`)).toEqual([A]);
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

describe("dual-scheme compatibility (#1177)", () => {
  it("fileUri emits appfile:// and only appfile://", () => {
    expect(fileUri(A)).toBe(`${FILE_URI_PREFIX}${A}`);
    expect(fileUri(A)).toBe(`appfile://${A}`);
    expect(fileUri(A).startsWith(LEGACY_DOCUMENT_URI_PREFIX)).toBe(false);
  });

  it("parseFileUri accepts both schemes and yields the same id", () => {
    expect(parseFileUri(`appfile://${A}`)).toBe(A);
    expect(parseFileUri(`document://${A}`)).toBe(A);
  });

  it("parseFileUri still rejects a malformed id under either scheme", () => {
    expect(parseFileUri("appfile://doc_bad")).toBeNull();
    expect(parseFileUri("document://doc_bad")).toBeNull();
    expect(parseFileUri(`file://${A}`)).toBeNull();
    expect(parseFileUri(`upload://upl_aaaaaaaa`)).toBeNull();
  });

  it("isFileUri / isAttachmentUri accept both schemes", () => {
    expect(isFileUri(`appfile://${A}`)).toBe(true);
    expect(isFileUri(`document://${A}`)).toBe(true);
    expect(isFileUri(`file://${A}`)).toBe(false);
    expect(isAttachmentUri(`document://${A}`)).toBe(true);
    expect(isAttachmentUri(`upload://upl_aaaaaaaa`)).toBe(true);
    expect(isAttachmentUri(`https://example.com/x`)).toBe(false);
  });

  it("extractFileIds finds legacy document:// references in a historical runs.input", () => {
    // The exact shape a run persisted before #1177: the parser must keep
    // resolving it, or every such run stops finding its own input files.
    const historicalInput = { report: `document://${A}`, images: [`document://${B}`] };
    expect(extractFileIds(historicalInput)).toEqual([A, B]);
  });

  it("extractFileIds de-duplicates across the two spellings of one id", () => {
    expect(extractFileIds({ a: `document://${A}`, b: `appfile://${A}` })).toEqual([A]);
  });

  it("extractFileIdsFromText scans prose for either scheme", () => {
    expect(extractFileIdsFromText(`old document://${A} and new appfile://${B}`)).toEqual([A, B]);
  });
});
