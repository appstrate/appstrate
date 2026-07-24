// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the run-detail "partial deliverables" banner logic
 * (`run-artifacts-banner.tsx`). The web test runner has no DOM, so we exercise
 * the pure helpers that decide WHETHER the banner renders and WHICH failed
 * names + code labels it shows, plus a source scan that the component maps the
 * failed list through them.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { partialArtifactFailures, artifactFailureCodeKey } from "../run-artifacts.ts";

describe("partialArtifactFailures", () => {
  it("returns the failed list when the summary is partial", () => {
    const failures = partialArtifactFailures({
      status: "partial",
      published: 1,
      failed: [
        { name: "outputs/big.csv", code: "file_too_large" },
        { name: "outputs/late.md", code: "conflict" },
      ],
    });
    expect(failures).toEqual([
      { name: "outputs/big.csv", code: "file_too_large" },
      { name: "outputs/late.md", code: "conflict" },
    ]);
  });

  it("returns null for a complete summary (nothing lost)", () => {
    expect(partialArtifactFailures({ status: "complete", published: 3, failed: [] })).toBeNull();
  });

  it("returns null for a null / malformed summary", () => {
    expect(partialArtifactFailures(null)).toBeNull();
    expect(partialArtifactFailures(undefined)).toBeNull();
    expect(partialArtifactFailures("nope")).toBeNull();
    // `partial` but no failures array → nothing to show.
    expect(partialArtifactFailures({ status: "partial", published: 0 })).toBeNull();
  });

  it("drops malformed failed entries but keeps the well-formed ones", () => {
    const failures = partialArtifactFailures({
      status: "partial",
      published: 0,
      failed: [{ name: "ok.txt", code: "upload_failed" }, { name: 5 }, null],
    });
    expect(failures).toEqual([{ name: "ok.txt", code: "upload_failed" }]);
  });
});

describe("artifactFailureCodeKey", () => {
  it("maps each known code to its own i18n key", () => {
    expect(artifactFailureCodeKey("file_too_large")).toBe("run.artifacts.code.file_too_large");
    expect(artifactFailureCodeKey("quota_exceeded")).toBe("run.artifacts.code.quota_exceeded");
    expect(artifactFailureCodeKey("conflict")).toBe("run.artifacts.code.conflict");
    expect(artifactFailureCodeKey("upload_failed")).toBe("run.artifacts.code.upload_failed");
  });

  it("falls back to the `unknown` key for an unrecognised code (never a raw key)", () => {
    expect(artifactFailureCodeKey("something_new")).toBe("run.artifacts.code.unknown");
  });
});

describe("RunArtifactsBanner source", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../run-artifacts-banner.tsx", import.meta.url)),
    "utf-8",
  );

  it("renders each failed name and its code label through the helpers", () => {
    expect(source).toContain("partialArtifactFailures(artifacts)");
    expect(source).toContain("failures.map");
    expect(source).toContain("t(artifactFailureCodeKey(f.code))");
  });

  it("uses the agents i18n namespace and the partial title/message keys", () => {
    expect(source).toContain('useTranslation("agents")');
    expect(source).toContain('t("run.artifacts.partial.title")');
    expect(source).toContain('t("run.artifacts.partial.message")');
  });
});
