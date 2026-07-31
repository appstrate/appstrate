// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { documentActivation } from "../src/ui/doc-activation.ts";
import type { OpenDocument } from "../src/ui/runtime-context.ts";

const t = (key: string) => key;

describe("documentActivation", () => {
  it("reports a direct click as manual presentation to the host", () => {
    const calls: Parameters<OpenDocument>[] = [];
    const opener: OpenDocument = (...args) => calls.push(args);
    const activation = documentActivation({ id: "doc_1", name: "report.md" }, opener, () => {}, t);

    activation.onActivate();

    expect(calls).toEqual([[{ id: "doc_1", name: "report.md" }, { trigger: "manual" }]]);
    expect(activation.label).toBe("doc.previewOf");
  });

  it("keeps the authenticated download fallback when no host viewer exists", () => {
    const downloads: Array<[string, string]> = [];
    const activation = documentActivation(
      { id: "doc_2", name: "data.csv" },
      null,
      (id, name) => downloads.push([id, name]),
      t,
    );

    activation.onActivate();

    expect(downloads).toEqual([["doc_2", "data.csv"]]);
    expect(activation.label).toBe("doc.downloadOf");
  });
});
