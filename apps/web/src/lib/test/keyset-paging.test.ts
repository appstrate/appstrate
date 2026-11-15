// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { QueryClient, hashKey } from "@tanstack/react-query";
import { keysetPaging, pagedQueryKey } from "@appstrate/ui/keyset-paging";

describe("pagedQueryKey", () => {
  const key = pagedQueryKey("/api/files", { params: { query: { limit: 25 } } });

  it("is reached by a write's `[method, path]` invalidation", async () => {
    const qc = new QueryClient();
    qc.setQueryData(key, { pages: [], pageParams: [] });
    await qc.invalidateQueries({ queryKey: ["get", "/api/files"] });
    expect(qc.getQueryState(key)?.isInvalidated).toBe(true);
  });

  it("never collides with a plain query on the same path", () => {
    const plain = ["get", "/api/files", { params: { query: { limit: 25 } } }];
    expect(hashKey(key)).not.toBe(hashKey(plain));
  });
});

describe("keysetPaging", () => {
  it("pages on the last id seen while the server reports more", () => {
    const page = { hasMore: true, data: [{ id: "a" }, { id: "b" }] };
    expect(keysetPaging.getNextPageParam(page)).toBe("b");
    expect(keysetPaging.getNextPageParam({ ...page, hasMore: false })).toBeUndefined();
  });
});
