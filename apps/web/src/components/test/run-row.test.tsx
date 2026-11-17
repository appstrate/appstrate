// SPDX-License-Identifier: Apache-2.0

/** A run row in a list spanning spaces (the dashboard, the chat panel) names its run's space. */

import { describe, expect, it, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { $api } from "../../api/client.ts";
import { orgStore } from "../../stores/org-store.ts";
import { render } from "../../test/render.tsx";
import { makeRun } from "../../test/run-fixture.ts";
import i18n, { i18nReady } from "../../i18n.ts";
import { RunRow } from "../run-row.tsx";

await i18nReady;
await i18n.changeLanguage("fr");

const ORG_ID = "org_rows";

function row(spanning: boolean): string {
  const queryClient = new QueryClient();
  queryClient.setQueryData(
    $api.queryOptions("get", "/api/spaces", { params: { header: { "X-Org-Id": ORG_ID } } })
      .queryKey,
    {
      object: "list",
      hasMore: false,
      data: [
        { id: "spc_studio", name: "Studio", access: "member", permissions: [], personal: false },
      ],
    },
  );
  const org = spyOn(orgStore, "getInitialState").mockReturnValue({
    ...orgStore.getInitialState(),
    id: ORG_ID,
  });
  try {
    return render(
      <RunRow
        run={makeRun({ packageId: "@acme/reporter", spaceId: "spc_studio" })}
        agentName="Reporter"
        spanning={spanning}
      />,
      { queryClient },
    );
  } finally {
    org.mockRestore();
  }
}

describe("RunRow", () => {
  it("names the run's space in a list spanning spaces", () => {
    expect(row(true)).toContain("Studio");
  });

  it("names none in a list of the working space", () => {
    expect(row(false)).not.toContain("Studio");
  });
});
