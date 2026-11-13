// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import type { FileUploader } from "../src/harness-tools.ts";
import { runAgainstStub, stubGatewayModel } from "./helpers.ts";

/** Names of the tools the first model request offered. */
async function offeredTools(fileUploader?: FileUploader): Promise<string[]> {
  const { requests } = await runAgainstStub({
    model: stubGatewayModel("openai-completions"),
    runner: { modelRetry: false, ...(fileUploader ? { fileUploader } : {}) },
  });
  const body = JSON.parse(requests[0]!.body) as {
    tools?: Array<{ function?: { name?: string } }>;
  };
  return (body.tools ?? []).map((t) => t.function?.name ?? "");
}

describe("PiRunner — publish_file tool", () => {
  it("offers `publish_file` when the host supplies an uploader", async () => {
    const uploader: FileUploader = async () => {
      throw new Error("not called");
    };
    expect(await offeredTools(uploader)).toContain("publish_file");
  });

  it("offers no `publish_file` without an uploader", async () => {
    expect(await offeredTools()).not.toContain("publish_file");
  });
});
