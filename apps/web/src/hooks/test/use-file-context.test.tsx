// SPDX-License-Identifier: Apache-2.0

/**
 * `useFile` with an explicit context (the reader link): the request names the
 * link's organization and space, the cache keys it apart from the current
 * scope, the current space's grants do not hold it back, and neither store moves.
 *
 * No DOM: a probe mounts the hook during a static render, which builds the
 * query in the cache without fetching it.
 */

import { describe, expect, it } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const { $api } = await import("../../api/client.ts");
const { render } = await import("../../test/render.tsx");
const { useFile } = await import("../use-files.ts");
const { orgStore } = await import("../../stores/org-store.ts");
const { spaceStore } = await import("../../stores/space-store.ts");
type FileContext = import("../../lib/file-link.ts").FileContext;

function mountedQuery(context?: FileContext) {
  const queryClient = new QueryClient();
  function Probe() {
    useFile("file_1", context);
    return null;
  }
  render(<Probe />, { queryClient });
  // `usePermissions` mounts the org listing beside it.
  return queryClient.getQueryCache().find({ queryKey: ["get", "/api/files/{id}"], exact: false })!;
}

const keyFor = (header: Record<string, string>) =>
  $api.queryOptions("get", "/api/files/{id}", { params: { path: { id: "file_1" }, header } })
    .queryKey;

// `enabled` is an observer option, absent from the cached query's type.
const enabledOf = (context?: FileContext) =>
  (mountedQuery(context).options as { enabled?: boolean }).enabled;

describe("useFile with an explicit context", () => {
  orgStore.getState().setId("org_current");
  spaceStore.getState().setId("spc_current");

  it("asks in the link's space and keys the cache on it", () => {
    const query = mountedQuery({ orgId: "org_link", spaceId: "spc_link" });
    expect(query.queryKey).toEqual(keyFor({ "X-Org-Id": "org_link", "X-Space-Id": "spc_link" }));
  });

  it("is not held back by the current space's grants", () => {
    // No permission set is loaded here: the current space grants nothing.
    expect(enabledOf({ orgId: "org_link", spaceId: "spc_link" })).toBe(true);
    expect(enabledOf()).toBe(false);
  });

  it("leaves the current organization and space as they were", () => {
    mountedQuery({ orgId: "org_link", spaceId: "spc_link" });
    expect(orgStore.getState().id).toBe("org_current");
    expect(spaceStore.getState().id).toBe("spc_current");
  });
});
