// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { fileActivation } from "../src/ui/file-activation.ts";
import type { OpenFile } from "../src/ui/runtime-context.ts";

const t = (key: string) => key;

describe("fileActivation", () => {
  it("delegates a direct click to the host's single file opener", () => {
    const calls: Parameters<OpenFile>[] = [];
    const opener: OpenFile = (...args) => calls.push(args);
    const activation = fileActivation({ id: "doc_1", name: "report.md" }, opener, () => {}, t);

    activation.onActivate();

    expect(calls).toEqual([[{ id: "doc_1", name: "report.md" }]]);
    expect(activation.label).toBe("file.previewOf");
  });

  it("keeps the authenticated download fallback when no host viewer exists", () => {
    const downloads: Array<[string, string]> = [];
    const activation = fileActivation(
      { id: "doc_2", name: "data.csv" },
      null,
      (id, name) => downloads.push([id, name]),
      t,
    );

    activation.onActivate();

    expect(downloads).toEqual([["doc_2", "data.csv"]]);
    expect(activation.label).toBe("file.downloadOf");
  });
});
