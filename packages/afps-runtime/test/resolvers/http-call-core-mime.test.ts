// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * `isTextLikeMimeType` — the predicate that decides whether an `http_call`
 * response body is UTF-8 decoded or kept as raw bytes.
 *
 * A false positive here is data loss, not a mislabel: the decode is lossy
 * (`fatal: false` → U+FFFD) and irreversible once re-encoded. That is exactly
 * how a substring `includes("xml")` match once corrupted every OOXML file
 * downloaded through `responseMode.toFile` — an XLSX is a ZIP.
 *
 * This file replaces `http-call-core-mime-parity.test.ts`, which asserted that
 * a hand-copy of the media-type set agreed with `@appstrate/core/mime`. The
 * copy is gone (both layers now read `@appstrate/afps-shared/mime`), so a
 * parity assertion over a single source would assert nothing. What still needs
 * pinning is the behaviour this module adds on top of the shared predicate:
 * the `http_call`-only charset rule, and the fact that it cannot rescue a
 * binary container.
 */

import { describe, expect, it } from "bun:test";
import { isTextLikeMimeType, serializeFetchResponse } from "../../src/resolvers/http-call-core.ts";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

describe("isTextLikeMimeType", () => {
  it.each([
    "text/plain",
    "text/csv",
    "application/json",
    "application/vnd.api+json",
    "application/xml",
    "application/atom+xml",
    "application/vnd.oai.openapi+yaml",
    "image/svg+xml",
    "application/x-ndjson",
    "application/yaml",
    "application/x-www-form-urlencoded",
  ])("decodes %s as text", (contentType) => {
    expect(isTextLikeMimeType(contentType)).toBe(true);
  });

  it.each([
    "application/octet-stream",
    "application/pdf",
    "image/png",
    "application/zip",
    XLSX,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel.sheet.macroenabled.12",
    "application/vnd.oasis.opendocument.spreadsheet",
    "application/epub+zip",
  ])("keeps %s as bytes", (contentType) => {
    expect(isTextLikeMimeType(contentType)).toBe(false);
  });

  it("treats an explicit charset parameter as a declaration of textness", () => {
    // The one rule this module adds over `@appstrate/afps-shared/mime`: an
    // upstream that bothers to declare a charset is telling us the body is
    // text, whatever the base type. The shared predicate stays media-type-only
    // because its other consumer (upload sniff enforcement) must not let a
    // caller talk a binary past the magic-byte check by appending a charset.
    expect(isTextLikeMimeType("application/octet-stream; charset=utf-8")).toBe(true);
    expect(isTextLikeMimeType("application/json;charset=UTF-8")).toBe(true);
    expect(isTextLikeMimeType("text/csv; charset=ISO-8859-1")).toBe(true);
  });

  it("never lets a charset parameter rescue an OOXML download", () => {
    // The asymmetry above is scoped to an actually-present charset signal. A
    // real OOXML response carries none, so the bytes survive — the regression
    // this predicate exists to prevent.
    expect(isTextLikeMimeType(XLSX)).toBe(false);
    expect(isTextLikeMimeType(`${XLSX}; boundary=x`)).toBe(false);
    // …and a server that blanket-appends a charset to every response must not
    // be able to flip an OOXML container onto the lossy text path. "an OOXML
    // container carries no charset" is a claim about upstream behaviour, not
    // an invariant we control.
    expect(isTextLikeMimeType(`${XLSX}; charset=utf-8`)).toBe(false);
    expect(isTextLikeMimeType("application/pdf; charset=utf-8")).toBe(false);
    expect(isTextLikeMimeType("image/png;charset=UTF-8")).toBe(false);
  });

  it("is case-insensitive and parameter-tolerant", () => {
    expect(isTextLikeMimeType("APPLICATION/JSON")).toBe(true);
    expect(isTextLikeMimeType("  application/json  ")).toBe(true);
    expect(isTextLikeMimeType("Image/PNG")).toBe(false);
  });

  it("classifies an absent Content-Type as binary", () => {
    // The safe default for unknown bytes is the binary path.
    expect(isTextLikeMimeType(null)).toBe(false);
    expect(isTextLikeMimeType(undefined)).toBe(false);
    expect(isTextLikeMimeType("")).toBe(false);
  });
});

/**
 * The declared media type that reaches {@link serializeFetchResponse}'s
 * sniffing step. `maybeSniffMimeType` compares it against the exact literal
 * `"application/octet-stream"` to decide whether the upstream said anything
 * useful — so the value MUST be normalized (parameters stripped, lowercased)
 * before it gets there. A third hand-rolled parser used to strip parameters
 * without lowercasing, which let `Application/Octet-Stream` masquerade as a
 * specific declared type: sniffing was skipped and the mixed-case string was
 * stored as the file's mime.
 */
describe("serializeFetchResponse declared-mime normalization", () => {
  // 8-byte PNG signature + IHDR header — enough for `file-type` to identify.
  const PNG_BYTES = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89,
  ]);

  async function serialize(contentType: string) {
    return serializeFetchResponse(
      new Response(PNG_BYTES, { headers: { "content-type": contentType } }),
      { workspace: "/nonexistent-workspace", toolCallId: "t1" },
    );
  }

  it.each([
    "application/octet-stream",
    "Application/Octet-Stream",
    "APPLICATION/OCTET-STREAM",
    "  application/octet-stream  ",
  ])("sniffs magic bytes when the upstream declares %s", async (contentType) => {
    const result = await serialize(contentType);
    expect(result.body.kind).toBe("inline");
    if (result.body.kind !== "inline") throw new Error("unreachable");
    expect(result.body.mimeType).toBe("image/png");
    expect(result.body.mimeTypeSniffed).toBe(true);
  });

  it("keeps a specific declared type and lowercases it", async () => {
    const result = await serialize("Image/JPEG");
    expect(result.body.kind).toBe("inline");
    if (result.body.kind !== "inline") throw new Error("unreachable");
    expect(result.body.mimeType).toBe("image/jpeg");
    expect(result.body.mimeTypeSniffed).toBeUndefined();
  });

  it("falls back to application/octet-stream when no Content-Type is sent", async () => {
    const result = await serializeFetchResponse(new Response(new TextEncoder().encode("hello")), {
      workspace: "/nonexistent-workspace",
      toolCallId: "t1",
    });
    expect(result.body.kind).toBe("inline");
    if (result.body.kind !== "inline") throw new Error("unreachable");
    expect(result.body.mimeType).toBe("application/octet-stream");
  });
});
