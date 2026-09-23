// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { createLlmKeyOutcomeReporter } from "../llm-key-health.ts";

function recorder() {
  const calls: Array<{ url: string; headers: RequestInit["headers"]; body: unknown }> = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: init?.headers, body: JSON.parse(String(init?.body)) });
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

describe("createLlmKeyOutcomeReporter", () => {
  const keySha256 = new Bun.CryptoHasher("sha256").update("sk-real").digest("hex");

  it("reports every 401, and a 2xx only first in the run or after a rejection", () => {
    const { calls, fetchFn } = recorder();
    const report = createLlmKeyOutcomeReporter({
      platformApiUrl: "http://platform",
      runToken: "rt",
      apiKey: "sk-real",
      fetchFn,
    });
    for (const status of [200, 200, 401, 401, 429, 200, 200, 403]) report(status);

    expect(calls.map((c) => (c.body as { outcome: string }).outcome)).toEqual([
      "accepted",
      "rejected",
      "rejected",
      "accepted",
    ]);
    expect(calls[0]!.url).toBe("http://platform/internal/model-credential/outcome");
    expect(calls[0]!.headers).toMatchObject({ Authorization: "Bearer rt" });
    // The fingerprint travels, never the key.
    expect(calls[0]!.body).toEqual({ outcome: "accepted", key_sha256: keySha256 });
    expect(JSON.stringify(calls)).not.toContain("sk-real");
  });

  it("never throws into the LLM path when the platform is unreachable", async () => {
    const report = createLlmKeyOutcomeReporter({
      platformApiUrl: "http://platform",
      runToken: "rt",
      apiKey: "sk-real",
      fetchFn: (async () => {
        throw new Error("down");
      }) as unknown as typeof fetch,
    });
    expect(() => report(401)).not.toThrow();
    await Bun.sleep(0);
  });
});
