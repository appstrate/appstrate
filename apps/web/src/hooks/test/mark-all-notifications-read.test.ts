// SPDX-License-Identifier: Apache-2.0

/**
 * « Tout marquer comme lu » across spaces sends one request per space: every one settles before
 * the outcome, a refusal fails it once, after the others landed.
 */

import { describe, expect, it } from "bun:test";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const { markAllReadIn } = await import("../use-notifications.ts");

describe("markAllReadIn", () => {
  it("sends one request per space, or one for the working space", async () => {
    const sent: (string | null)[] = [];
    const put = async (spaceId: string | null) => void sent.push(spaceId);
    await markAllReadIn(["spc_a", "spc_b"], put);
    await markAllReadIn(null, put);
    expect(sent).toEqual(["spc_a", "spc_b", null]);
  });

  it("lets every request land, then fails once with the first refusal", async () => {
    const landed: string[] = [];
    const refusal = new Error("refused in spc_a");
    const put = (spaceId: string | null) =>
      spaceId === "spc_a" || spaceId === "spc_c"
        ? Promise.reject(spaceId === "spc_a" ? refusal : new Error("refused in spc_c"))
        : new Promise<void>((resolve) =>
            setTimeout(() => {
              landed.push(spaceId!);
              resolve();
            }, 5),
          );
    await expect(markAllReadIn(["spc_a", "spc_b", "spc_c"], put)).rejects.toBe(refusal);
    // The slower space was not cut short by the earlier refusal.
    expect(landed).toEqual(["spc_b"]);
  });
});
