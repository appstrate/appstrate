// SPDX-License-Identifier: Apache-2.0

/**
 * Space cache invalidation after a write (#1678). The keys are built the way
 * the hooks build them — through the typed client — because the rule under
 * test reads the deleted id out of that key layout.
 */

import { describe, it, expect } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { $api } from "../../api/client.ts";
import { invalidateSpaces } from "../use-spaces.ts";

const header = { "X-Org-Id": "org_1" };
const detailKey = (id: string) =>
  $api.queryOptions("get", "/api/spaces/{id}", { params: { path: { id }, header } }).queryKey;
const rolesKey = (id: string) =>
  $api.queryOptions("get", "/api/spaces/{id}/roles", { params: { path: { id }, header } }).queryKey;
const LIST = $api.queryOptions("get", "/api/spaces", { params: { header } }).queryKey;

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A client with every read MOUNTED, counting the requests each one issues. */
async function mounted(keys: readonly (readonly unknown[])[]) {
  const qc = new QueryClient();
  const fetches = new Map<string, number>();
  for (const queryKey of keys) {
    const id = JSON.stringify(queryKey);
    new QueryObserver(qc, {
      queryKey,
      queryFn: () => {
        fetches.set(id, (fetches.get(id) ?? 0) + 1);
        return Promise.resolve(id);
      },
      staleTime: Infinity,
    }).subscribe(() => {});
  }
  await settled();
  return { qc, count: (key: readonly unknown[]) => fetches.get(JSON.stringify(key)) };
}

describe("invalidateSpaces", () => {
  const keys = [LIST, detailKey("spc_gone"), rolesKey("spc_gone"), detailKey("spc_kept")];

  it("refetches every space read after a write that deleted nothing", async () => {
    const { qc, count } = await mounted(keys);
    invalidateSpaces(qc);
    await settled();
    expect(keys.map(count)).toEqual([2, 2, 2, 2]);
  });

  it("leaves the reads of the deleted space stale, not refetched", async () => {
    const { qc, count } = await mounted(keys);
    invalidateSpaces(qc, "spc_gone");
    await settled();
    // The listing and the other space move; the page of the deleted one would
    // only fetch a 404.
    expect(keys.map(count)).toEqual([2, 1, 1, 2]);
    expect(qc.getQueryState(detailKey("spc_gone"))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(rolesKey("spc_gone"))?.isInvalidated).toBe(true);
  });
});
