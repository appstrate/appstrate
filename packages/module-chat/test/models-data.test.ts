// SPDX-License-Identifier: Apache-2.0

/**
 * The browser picker's `/api/models` reader. Its Zod schema strips unknown
 * keys, so a field spelled differently from the wire is not an error — it is
 * silently absent, and every model lands in the neutral "managed" group.
 */

import { describe, expect, it } from "bun:test";
import { selectChatModels } from "../src/ui/models-data.ts";

function envelope(rows: unknown[]) {
  return { object: "list", data: rows, hasMore: false };
}

const ROW = {
  id: "mdl_1",
  modelId: "gpt-4o",
  apiShape: "openai-completions",
  providerId: "opencode-go",
  label: "GPT-4o",
  enabled: true,
};

describe("selectChatModels", () => {
  it("keeps the wire's snake_case `provider_name`", () => {
    const [model] = selectChatModels(envelope([{ ...ROW, provider_name: "OpenCode Go" }]));
    expect(model?.provider_name).toBe("OpenCode Go");
  });

  it("does not read a camelCase `providerName`", () => {
    const [model] = selectChatModels(envelope([{ ...ROW, providerName: "OpenCode Go" }]));
    expect(model?.provider_name).toBeUndefined();
    expect(model).not.toHaveProperty("providerName");
  });
});
