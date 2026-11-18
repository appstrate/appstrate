// SPDX-License-Identifier: Apache-2.0

/**
 * « Tout marquer comme lu » (the runs, the bell) sends one request per space the list spans: every
 * one settles before the outcome, a refusal fails it once, after the others landed.
 */

import { describe, expect, it } from "bun:test";
import { markAllReadIn, type SpaceScopedInit } from "../mark-all-read.ts";

const spaceOf = (init: SpaceScopedInit) =>
  (init as { headers?: Record<string, string> }).headers?.["X-Space-Id"] ?? null;

describe("markAllReadIn", () => {
  it("sends one request per space naming it, or one naming none for the working space", async () => {
    const sent: SpaceScopedInit[] = [];
    const put = async (init: SpaceScopedInit) => void sent.push(init);
    await markAllReadIn(["spc_a", "spc_b"], put);
    await markAllReadIn(null, put);
    expect(sent).toEqual([
      { headers: { "X-Space-Id": "spc_a" } },
      { headers: { "X-Space-Id": "spc_b" } },
      {},
    ]);
  });

  it("sends nothing when the list spans no space", async () => {
    let sent = 0;
    await markAllReadIn([], async () => void sent++);
    expect(sent).toBe(0);
  });

  it("lets every request land, then fails once with the first refusal", async () => {
    const landed: string[] = [];
    const refusal = new Error("refused in spc_a");
    const put = (init: SpaceScopedInit) => {
      const spaceId = spaceOf(init);
      return spaceId === "spc_a" || spaceId === "spc_c"
        ? Promise.reject(spaceId === "spc_a" ? refusal : new Error("refused in spc_c"))
        : new Promise<void>((resolve) =>
            setTimeout(() => {
              landed.push(spaceId!);
              resolve();
            }, 5),
          );
    };
    await expect(markAllReadIn(["spc_a", "spc_b", "spc_c"], put)).rejects.toBe(refusal);
    // The slower space was not cut short by the earlier refusal.
    expect(landed).toEqual(["spc_b"]);
  });
});
