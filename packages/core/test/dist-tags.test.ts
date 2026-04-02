// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { DIST_TAG_REGEX, isValidDistTag, isProtectedTag } from "../src/dist-tags.ts";

describe("DIST_TAG_REGEX", () => {
  test("matches simple tags", () => {
    expect(DIST_TAG_REGEX.test("latest")).toBe(true);
    expect(DIST_TAG_REGEX.test("beta")).toBe(true);
    expect(DIST_TAG_REGEX.test("next")).toBe(true);
  });

  test("matches tags with dots, hyphens, underscores", () => {
    expect(DIST_TAG_REGEX.test("pre-release")).toBe(true);
    expect(DIST_TAG_REGEX.test("v1.0")).toBe(true);
    expect(DIST_TAG_REGEX.test("release_candidate")).toBe(true);
    expect(DIST_TAG_REGEX.test("rc.1")).toBe(true);
  });

  test("rejects tags starting with numbers", () => {
    expect(DIST_TAG_REGEX.test("1beta")).toBe(false);
    expect(DIST_TAG_REGEX.test("0.1")).toBe(false);
  });

  test("rejects tags with uppercase", () => {
    expect(DIST_TAG_REGEX.test("Beta")).toBe(false);
    expect(DIST_TAG_REGEX.test("LATEST")).toBe(false);
  });

  test("rejects empty string", () => {
    expect(DIST_TAG_REGEX.test("")).toBe(false);
  });

  test("rejects tags with spaces or special chars", () => {
    expect(DIST_TAG_REGEX.test("my tag")).toBe(false);
    expect(DIST_TAG_REGEX.test("tag@1")).toBe(false);
    expect(DIST_TAG_REGEX.test("tag/1")).toBe(false);
  });
});

describe("isValidDistTag", () => {
  test("valid tags return true", () => {
    expect(isValidDistTag("latest")).toBe(true);
    expect(isValidDistTag("beta")).toBe(true);
    expect(isValidDistTag("rc.1")).toBe(true);
    expect(isValidDistTag("pre-release")).toBe(true);
  });

  test("invalid tags return false", () => {
    expect(isValidDistTag("")).toBe(false);
    expect(isValidDistTag("1beta")).toBe(false);
    expect(isValidDistTag("Beta")).toBe(false);
    expect(isValidDistTag("my tag")).toBe(false);
  });
});

describe("isProtectedTag", () => {
  test('"latest" is protected', () => {
    expect(isProtectedTag("latest")).toBe(true);
  });

  test("other tags are not protected", () => {
    expect(isProtectedTag("beta")).toBe(false);
    expect(isProtectedTag("next")).toBe(false);
    expect(isProtectedTag("rc")).toBe(false);
    expect(isProtectedTag("")).toBe(false);
  });
});
