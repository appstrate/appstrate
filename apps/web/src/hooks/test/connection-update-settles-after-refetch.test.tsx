// SPDX-License-Identifier: Apache-2.0

/**
 * A connection update (label or sharing) stays pending until the connection
 * list has been refetched. The share editor is disabled while `pending`; were
 * the mutation to settle first, it would re-enable on the stale
 * `shared_space_ids` and a second pick would send `[B]` instead of `[A, B]`.
 *
 * No DOM: a probe captures each hook during a static render, the list query is
 * kept active by a bare observer whose fetch is held open by hand.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { toast } from "sonner";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const { $api, client } = await import("../../api/client.ts");
const { render } = await import("../../test/render.tsx");
const { useUpdateIntegrationConnection } = await import("../use-integrations.ts");
const { useUpdateMeIntegrationConnection } = await import("../use-me-connections.ts");

const header = { "X-Org-Id": undefined, "X-Space-Id": undefined };
const ME_LIST_KEY = $api.queryOptions("get", "/api/me/connections", {}).queryKey;
const SPACE_LIST_KEY = $api.queryOptions("get", "/api/integrations/{packageId}/connections", {
  params: { path: { packageId: "@acme/gmail" }, header },
}).queryKey;

function capture<T>(useHook: () => T, qc: QueryClient): T {
  const captured: T[] = [];
  function Probe() {
    captured.push(useHook());
    return null;
  }
  render(<Probe />, { queryClient: qc });
  return captured[0]!;
}

/** An active list query whose refetch resolves only when the test says so. */
function slowList(qc: QueryClient, queryKey: readonly unknown[]) {
  qc.setQueryData(queryKey, { shared: [] });
  let release!: () => void;
  const observer = new QueryObserver(qc, {
    queryKey,
    staleTime: Infinity,
    queryFn: () =>
      new Promise((resolve) => {
        release = () => resolve({ shared: ["spc_a"] });
      }),
  });
  const unsubscribe = observer.subscribe(() => {});
  return { release: () => release(), unsubscribe };
}

const status = (qc: QueryClient) => qc.getMutationCache().getAll()[0]!.state.status;

let stubs: { mockRestore: () => void }[];
beforeEach(() => {
  stubs = [
    spyOn(toast, "success").mockImplementation(() => 0),
    spyOn(client, "PATCH").mockResolvedValue({ data: { id: "conn_1" } }),
  ];
});
afterEach(() => {
  for (const s of stubs) s.mockRestore();
});

describe("connection update — settles after the list refetch", () => {
  const cases: {
    name: string;
    key: readonly unknown[];
    run: (qc: QueryClient) => Promise<unknown>;
  }[] = [
    {
      name: "user-scope (/api/me/connections)",
      key: ME_LIST_KEY,
      run: (qc: QueryClient) =>
        capture(() => useUpdateMeIntegrationConnection(), qc).mutateAsync({
          connectionId: "conn_1",
          body: { shared_space_ids: ["spc_a"] },
        }),
    },
    {
      name: "space-scope (/api/integrations/{packageId}/connections)",
      key: SPACE_LIST_KEY,
      run: (qc: QueryClient) =>
        capture(() => useUpdateIntegrationConnection(), qc).mutateAsync({
          params: { path: { packageId: "@acme/gmail", connectionId: "conn_1" } },
          body: { shared_space_ids: ["spc_a"] },
        }),
    },
  ];

  for (const c of cases) {
    it(`${c.name}: pending while the list GET is outstanding`, async () => {
      const qc = new QueryClient();
      const list = slowList(qc, c.key);
      let settled = false;
      const done = c.run(qc).then(() => {
        settled = true;
      });

      await Bun.sleep(5);
      expect(status(qc)).toBe("pending");
      expect(settled).toBe(false);
      expect(qc.getQueryData<unknown>(c.key)).toEqual({ shared: [] });

      list.release();
      await done;
      expect(status(qc)).toBe("success");
      // The editor re-enables on the refetched sharing, not the pre-write one.
      expect(qc.getQueryData<unknown>(c.key)).toEqual({ shared: ["spc_a"] });
      list.unsubscribe();
    });
  }
});
