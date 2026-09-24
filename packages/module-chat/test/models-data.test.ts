// SPDX-License-Identifier: Apache-2.0

/**
 * The browser picker's `/api/models` reader. Its Zod schema strips unknown
 * keys, so a field spelled differently from the wire is not an error — it is
 * silently absent, and every model lands in the neutral "managed" group.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { fetchModels } from "../src/ui/models-data.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function serve(rows: unknown[]): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ object: "list", data: rows, hasMore: false }))) as typeof fetch;
}

const ROW = {
  id: "mdl_1",
  modelId: "gpt-4o",
  apiShape: "openai-completions",
  providerId: "opencode-go",
  label: "GPT-4o",
  enabled: true,
};

describe("fetchModels", () => {
  it("keeps the wire's snake_case `provider_name`", async () => {
    serve([{ ...ROW, provider_name: "OpenCode Go" }]);
    const [model] = await fetchModels();
    expect(model?.provider_name).toBe("OpenCode Go");
  });

  it("does not read a camelCase `providerName` the server no longer sends", async () => {
    serve([{ ...ROW, providerName: "OpenCode Go" }]);
    const [model] = await fetchModels();
    expect(model?.provider_name).toBeUndefined();
    expect(model).not.toHaveProperty("providerName");
  });
});
