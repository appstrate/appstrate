// SPDX-License-Identifier: Apache-2.0

/**
 * A write that changes what the library lists marks BOTH of its forms stale.
 * `useCatalogueLibrary` serves an administrator `/api/library` and everybody
 * else each space's `/api/spaces/{spaceId}/library`: refreshing the first alone
 * leaves a member's picker without the MCP server they just imported, and the
 * integration editor says « serveur introuvable » until the cache expires.
 */

import { describe, expect, it } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { $api } from "../../api/client.ts";
import { invalidateLibraries } from "../use-library.ts";

const header = { "X-Org-Id": "org_a" };

describe("invalidateLibraries", () => {
  it("marks the organization's library and every space's library stale", async () => {
    const qc = new QueryClient();
    const keys = [
      $api.queryOptions("get", "/api/library", { params: { header } }).queryKey,
      $api.queryOptions("get", "/api/spaces/{spaceId}/library", {
        params: { path: { spaceId: "spc_a" }, header },
      }).queryKey,
      $api.queryOptions("get", "/api/spaces/{spaceId}/library", {
        params: { path: { spaceId: "spc_b" }, header },
      }).queryKey,
    ];
    for (const key of keys) qc.setQueryData(key, { object: "library" });

    await invalidateLibraries(qc);

    expect(keys.map((key) => qc.getQueryState(key)?.isInvalidated)).toEqual([true, true, true]);
  });

  it("CONTROL: leaves an unrelated query alone", async () => {
    const qc = new QueryClient();
    const spaces = $api.queryOptions("get", "/api/spaces", { params: { header } }).queryKey;
    qc.setQueryData(spaces, { object: "list", data: [], hasMore: false });

    await invalidateLibraries(qc);

    expect(qc.getQueryState(spaces)?.isInvalidated).toBe(false);
  });
});
