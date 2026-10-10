// SPDX-License-Identifier: Apache-2.0

/**
 * A connection write (rename or share into a space) stays pending until the
 * connection list has been refetched. The share editor is disabled while
 * `pending`; were the mutation to settle first, it would re-enable on the stale
 * `shared_here` and a second pick would act on the wrong state.
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
const { useRenameIntegrationConnection, useShareConnection } =
  await import("../use-integrations.ts");
const { useRenameMeConnection, useShareMeConnection } = await import("../use-me-connections.ts");

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
    spyOn(client, "PUT").mockResolvedValue({ response: new Response(null, { status: 204 }) }),
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
      name: "user-scope rename (/api/me/connections)",
      key: ME_LIST_KEY,
      run: (qc: QueryClient) =>
        capture(() => useRenameMeConnection(), qc).mutateAsync({
          connectionId: "conn_1",
          body: { label: "Work" },
        }),
    },
    {
      name: "user-scope share (/api/me/connections/{connectionId}/shares/{spaceId})",
      key: ME_LIST_KEY,
      run: (qc: QueryClient) =>
        capture(() => useShareMeConnection(), qc).mutateAsync({
          connectionId: "conn_1",
          spaceId: "spc_a",
        }),
    },
    {
      name: "space-scope rename (/api/integrations/{packageId}/connections)",
      key: SPACE_LIST_KEY,
      run: (qc: QueryClient) =>
        capture(() => useRenameIntegrationConnection(), qc).mutateAsync({
          params: { path: { packageId: "@acme/gmail", connectionId: "conn_1" } },
          body: { label: "Work" },
        }),
    },
    {
      name: "space-scope share (/api/integrations/{packageId}/connections/{connectionId}/shares/{spaceId})",
      key: SPACE_LIST_KEY,
      run: (qc: QueryClient) =>
        capture(() => useShareConnection(), qc).mutateAsync({
          params: {
            path: { packageId: "@acme/gmail", connectionId: "conn_1", spaceId: "spc_a" },
          },
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
