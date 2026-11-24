// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { fileActivation } from "../src/ui/file-activation.ts";
import type { OpenFile } from "../src/ui/runtime-context.ts";

const t = (key: string) => key;

describe("fileActivation", () => {
  it("delegates a direct click to the host's single file opener", () => {
    const calls: Parameters<OpenFile>[] = [];
    const opener: OpenFile = (...args) => calls.push(args);
    const activation = fileActivation({ id: "file_1", name: "report.md" }, opener, t);

    activation.onActivate();

    expect(calls).toEqual([[{ id: "file_1", name: "report.md" }]]);
    expect(activation.label).toBe("file.previewOf");
  });

  it("carries the file's own space and gives an unnamed file a localized label", () => {
    const opened: Parameters<OpenFile>[] = [];
    const activation = fileActivation(
      { id: "file_3", name: "", spaceId: "spc_b" },
      (...args) => opened.push(args),
      (key, options) => (key === "file.previewOf" ? String(options?.name) : key),
    );
    activation.onActivate();
    expect(opened).toEqual([[{ id: "file_3", name: "file", spaceId: "spc_b" }]]);
    expect(activation.label).toBe("file.unnamed");
  });
});
