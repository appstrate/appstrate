// SPDX-License-Identifier: Apache-2.0

/** A run list whose background refetch failed keeps the runs it already shows. */

import { describe, it, expect } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type { EnrichedRun, ListEnvelope } from "@appstrate/shared-types";
import commonFr from "../../locales/fr/common.json";
import i18n, { i18nReady } from "../../i18n.ts";
import { paginatedRunsKeys } from "../../lib/query-keys.ts";
import { render } from "../../test/render.tsx";
import { RunList } from "../run-list.tsx";
import { makeRun } from "./run-fixture.tsx";

await i18nReady;
await i18n.changeLanguage("fr");

const PACKAGE_ID = "@acme/reporter";
const RUN_HREF = `/agents/${PACKAGE_ID}/runs/run_1`;

/** The cache entry `RunList` reads for an agent's first page, left failed by its last fetch. */
function failedQuery(data: ListEnvelope<EnrichedRun> | undefined): QueryClient {
  const queryClient = new QueryClient();
  const key = paginatedRunsKeys.list(
    null,
    null,
    `/agents/${PACKAGE_ID}/runs`,
    undefined,
    undefined,
    undefined,
    undefined,
    20,
    0,
  );
  if (data) queryClient.setQueryData(key, data);
  const query = queryClient.getQueryCache().build(queryClient, { queryKey: key });
  query.setState({ status: "error", error: new Error("refetch failed"), fetchFailureCount: 1 });
  return queryClient;
}

describe("RunList after a failed fetch", () => {
  it("keeps the loaded runs when a background refetch fails", () => {
    const envelope = {
      object: "list",
      data: [makeRun({ packageId: PACKAGE_ID })],
      total: 1,
      hasMore: false,
    } as unknown as ListEnvelope<EnrichedRun>;
    const html = render(<RunList packageId={PACKAGE_ID} />, {
      queryClient: failedQuery(envelope),
    });
    expect(html).toContain(RUN_HREF);
    expect(html).not.toContain(commonFr["error.generic"]);
  });

  it("says the listing failed when nothing was ever loaded", () => {
    const html = render(<RunList packageId={PACKAGE_ID} />, {
      queryClient: failedQuery(undefined),
    });
    expect(html).not.toContain(RUN_HREF);
    expect(html).toContain(commonFr["error.generic"]);
  });
});
