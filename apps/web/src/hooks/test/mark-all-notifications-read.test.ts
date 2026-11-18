// SPDX-License-Identifier: Apache-2.0

/**
 * « Tout marquer comme lu » across spaces sends one request per space: every one settles before
 * the outcome, a refusal fails it once, after the others landed.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { createElement } from "react";
import { QueryClient } from "@tanstack/react-query";
import { installSpaStorage } from "../../test/fake-storage.ts";

installSpaStorage();

const { client } = await import("../../api/client.ts");
const { render } = await import("../../test/render.tsx");
const { markAllReadIn, useMarkAllRead } = await import("../use-notifications.ts");

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

describe("useMarkAllRead", () => {
  function mount() {
    const qc = new QueryClient();
    const box: { mutation?: ReturnType<typeof useMarkAllRead> } = {};
    function Probe() {
      box.mutation = useMarkAllRead();
      return null;
    }
    render(createElement(Probe), { queryClient: qc });
    return { qc, mutation: box.mutation! };
  }

  it("names a space only when one is listed: the working space's request carries none", async () => {
    const put = spyOn(client, "PUT").mockResolvedValue({ data: undefined });
    try {
      const { mutation } = mount();
      await mutation.mutateAsync(null);
      await mutation.mutateAsync(["spc_b"]);
      const inits = put.mock.calls.map((call) => call[1] as { headers?: Record<string, string> });
      expect(inits[0]?.headers).toBeUndefined();
      expect(inits[1]?.headers).toEqual({ "X-Space-Id": "spc_b" });
    } finally {
      put.mockRestore();
    }
  });

  it("refreshes the organization's feeds too, the ones « Tous les espaces » reads", async () => {
    const put = spyOn(client, "PUT").mockResolvedValue({ data: undefined });
    try {
      const { qc, mutation } = mount();
      const invalidate = spyOn(qc, "invalidateQueries");
      await mutation.mutateAsync(["spc_a", "spc_b"]);
      const roots = invalidate.mock.calls.map(
        (call) => (call[0] as { queryKey: unknown[] }).queryKey[1],
      );
      expect(roots).toContain("/api/orgs/{orgId}/notifications");
      expect(roots).toContain("/api/orgs/{orgId}/notifications/unread-count");
    } finally {
      put.mockRestore();
    }
  });
});
