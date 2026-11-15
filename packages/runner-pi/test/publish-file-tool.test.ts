// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import type { FileUploader } from "../src/harness-tools.ts";
import { offeredTools } from "./helpers.ts";

describe("PiRunner — publish_file tool", () => {
  it("offers `publish_file` when the host supplies an uploader", async () => {
    const uploader: FileUploader = async () => {
      throw new Error("not called");
    };
    expect(await offeredTools({ fileUploader: uploader })).toContain("publish_file");
  });

  it("offers no `publish_file` without an uploader", async () => {
    expect(await offeredTools()).not.toContain("publish_file");
  });
});
