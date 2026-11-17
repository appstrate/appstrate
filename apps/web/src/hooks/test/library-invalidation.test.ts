// SPDX-License-Identifier: Apache-2.0

/**
 * A write that changes what the library lists marks BOTH of its forms stale:
 * `/api/library` (the catalogue, the pickers) and the current space's
 * `/api/spaces/{id}/library` (activation state). Refreshing one alone
 * leaves the other's reader on a stale list — a picker without the MCP server
 * just imported, and the integration editor saying « serveur introuvable »
 * until the cache expires.
 */

import { describe, expect, it } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { $api } from "../../api/client.ts";
import { invalidateLibraries } from "../use-library.ts";

const header = { "X-Org-Id": "org_a" };

describe("invalidateLibraries", () => {
  it("invalidates both libraries and the placements used to resolve a direct link", async () => {
    const qc = new QueryClient();
    const keys = [
      $api.queryOptions("get", "/api/library", { params: { header } }).queryKey,
      $api.queryOptions("get", "/api/spaces/{id}/library", {
        params: { path: { id: "spc_a" }, header },
      }).queryKey,
      $api.queryOptions("get", "/api/spaces/{id}/library", {
        params: { path: { id: "spc_b" }, header },
      }).queryKey,
      $api.queryOptions("get", "/api/packages/{scope}/{name}/home", {
        params: {
          path: { scope: "@acme", name: "worker" },
          header: { ...header, "X-Space-Id": "spc_a" },
        },
      }).queryKey,
    ];
    for (const key of keys) qc.setQueryData(key, { object: "library" });

    await invalidateLibraries(qc);

    expect(keys.map((key) => qc.getQueryState(key)?.isInvalidated)).toEqual([
      true,
      true,
      true,
      true,
    ]);
  });

  it("CONTROL: leaves an unrelated query alone", async () => {
    const qc = new QueryClient();
    const spaces = $api.queryOptions("get", "/api/spaces", { params: { header } }).queryKey;
    qc.setQueryData(spaces, { object: "list", data: [], hasMore: false });

    await invalidateLibraries(qc);

    expect(qc.getQueryState(spaces)?.isInvalidated).toBe(false);
  });
});
