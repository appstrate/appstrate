// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, spyOn } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { installFakeStorage } from "../../test/fake-storage";

installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
  location: { origin: "https://app.example.test" },
});

const { render } = await import("../../test/render");
const { useIntegrationsById, invalidateIntegrationQueries } = await import("../use-integrations");
const { client } = await import("../../api/client");
const { orgStore } = await import("../../stores/org-store");
const { spaceStore } = await import("../../stores/space-store");

function Integrations({ ids }: { ids: string[] }) {
  useIntegrationsById(ids);
  return null;
}

function optionsFor(qc: QueryClient, ids: string[], orgId = "org_a", spaceId = "space_a") {
  const org = spyOn(orgStore, "getInitialState").mockReturnValue({
    ...orgStore.getInitialState(),
    id: orgId,
  });
  const space = spyOn(spaceStore, "getInitialState").mockReturnValue({
    ...spaceStore.getInitialState(),
    id: spaceId,
  });
  try {
    render(<Integrations ids={ids} />, { queryClient: qc });
    const queries = qc
      .getQueryCache()
      .findAll()
      .filter((q) => q.queryKey[1] === "/api/integrations");
    const query = queries[queries.length - 1];
    if (!query) throw new Error("Missing integration query");
    return { ...query.options, queryKey: query.queryKey, enabled: true };
  } finally {
    org.mockRestore();
    space.mockRestore();
  }
}

describe("integrations by id", () => {
  it("retains the combined rows while the id set changes, only within the same org and space", () => {
    const qc = new QueryClient();
    try {
      const initial = optionsFor(qc, ["@a/one"]);
      const rows = [{ id: "@a/one" }];
      qc.setQueryData(initial.queryKey, rows);
      const observer = new QueryObserver(qc, initial);
      const next = optionsFor(qc, ["@a/one", "@a/two"]);
      const waiting = observer.getOptimisticResult(qc.defaultQueryOptions(next));
      expect(waiting.data).toEqual(rows);
      expect(waiting.isPlaceholderData).toBe(true);
      for (const [org, space] of [
        ["org_b", "space_a"],
        ["org_a", "space_b"],
      ]) {
        const changedScope = optionsFor(qc, ["@a/one", "@a/two"], org, space);
        const result = observer.getOptimisticResult(qc.defaultQueryOptions(changedScope));
        expect(result.data).toBeUndefined();
        expect(result.isPlaceholderData).toBe(false);
      }
    } finally {
      qc.clear();
    }
  });

  it("aggregates over 100 unique ids into one observed result and bounded requests", async () => {
    const qc = new QueryClient();
    const ids = Array.from({ length: 101 }, (_, i) => `@a/item-${i}`);
    const options = optionsFor(qc, [...ids, ids[0]!].reverse());
    const sorted = [...ids].sort();
    const get = spyOn(client, "GET")
      .mockResolvedValueOnce({
        data: { data: sorted.slice(0, 100).map((id) => ({ id })) },
        response: new Response(),
      })
      .mockResolvedValueOnce({
        data: { data: sorted.slice(100).map((id) => ({ id })) },
        response: new Response(),
      });
    try {
      expect(
        qc
          .getQueryCache()
          .findAll()
          .filter((q) => q.queryKey[1] === "/api/integrations"),
      ).toHaveLength(1);
      expect(await qc.fetchQuery(options)).toEqual([...ids].sort().map((id) => ({ id })));
      expect(get).toHaveBeenCalledTimes(2);
      await invalidateIntegrationQueries(qc);
      expect(qc.getQueryState(options.queryKey)?.isInvalidated).toBe(true);
      for (const [i, chunk] of [sorted.slice(0, 100), sorted.slice(100)].entries()) {
        expect(get).toHaveBeenNthCalledWith(i + 1, "/api/integrations", {
          params: {
            query: { id: chunk, limit: 100 },
            header: { "X-Org-Id": "org_a", "X-Space-Id": "space_a" },
          },
          signal: expect.any(AbortSignal),
        });
      }
    } finally {
      get.mockRestore();
      qc.clear();
    }
  });
});
