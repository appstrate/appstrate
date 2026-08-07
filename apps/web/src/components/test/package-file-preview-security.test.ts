// SPDX-License-Identifier: Apache-2.0

/**
 * Narrow source guards for the two security decisions that cannot be exercised
 * in the DOM-less web test runner: package bytes stay editor source, and the
 * download blob stays inert.
 *
 * Manifest links are covered behaviorally in `manifest-overview.test.tsx` and
 * `lib/test/package-manifest.test.ts`; keeping a closed import graph here made
 * harmless refactors update a second manual allowlist without adding coverage.
 */

import { describe, it, expect } from "bun:test";

const previewSource = await Bun.file(
  decodeURIComponent(new URL("../package-files/file-preview.tsx", import.meta.url).pathname),
).text();
const downloadSource = await Bun.file(
  decodeURIComponent(new URL("../package-files/use-package-file.ts", import.meta.url).pathname),
).text();

describe("package file preview security", () => {
  it("renders author-controlled bytes as Monaco source", () => {
    expect(previewSource).toContain("<MonacoEditor");
    for (const sink of [
      "dangerouslySetInnerHTML",
      "<iframe",
      "srcDoc=",
      "<img",
      "<object",
      "<embed",
    ]) {
      expect(previewSource).not.toContain(sink);
    }
  });

  it("downloads through an inert blob instead of navigating to package bytes", () => {
    expect(downloadSource).toContain(
      'new Blob([data ?? ""], { type: "application/octet-stream" })',
    );
    expect(downloadSource).toContain("a.download = baseName(path)");
    expect(downloadSource).not.toContain("window.open(");
    expect(downloadSource).not.toContain("location.assign(");
    expect(downloadSource).not.toContain("location.replace(");
  });
});
