// SPDX-License-Identifier: Apache-2.0

/**
 * `useOwnPersonalSpaceId` tells « loading » from « none »: a listing that answered without the
 * caller's personal space is `failed`, so the composer explains it instead of waiting forever.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const { $api } = await import("../../api/client.ts");
const { orgStore } = await import("../../stores/org-store.ts");
const { render } = await import("../../test/render.tsx");
const { useOwnPersonalSpaceId } = await import("../use-spaces.ts");

const ORG_ID = "org_personal_hook";

function Probe() {
  return <output>{JSON.stringify(useOwnPersonalSpaceId())}</output>;
}

/** The hook's answer with the listing cached as `spaces`, or not answered yet when undefined. */
function answer(spaces?: Array<{ id: string; personal: boolean; access: "member" | "none" }>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  if (spaces) {
    queryClient.setQueryData(
      $api.queryOptions("get", "/api/spaces", { params: { header: { "X-Org-Id": ORG_ID } } })
        .queryKey,
      { object: "list", data: spaces, hasMore: false },
    );
  }
  const org = spyOn(orgStore, "getInitialState").mockReturnValue({
    ...orgStore.getInitialState(),
    id: ORG_ID,
  });
  try {
    const html = render(<Probe />, { queryClient });
    return JSON.parse(html.replace(/^<output>|<\/output>$/g, "")) as {
      spaceId: string | null;
      failed: boolean;
    };
  } finally {
    org.mockRestore();
  }
}

describe("useOwnPersonalSpaceId", () => {
  it("is loading until the listing answers", () => {
    expect(answer()).toEqual({ spaceId: null, failed: false });
  });

  it("names the caller's personal space once listed", () => {
    expect(answer([{ id: "spc_mine", personal: true, access: "member" }])).toEqual({
      spaceId: "spc_mine",
      failed: false,
    });
  });

  it("fails a listing that answered without it, instead of loading forever", () => {
    expect(
      answer([
        { id: "spc_team", personal: false, access: "member" },
        { id: "spc_orphan", personal: true, access: "none" },
      ]),
    ).toEqual({ spaceId: null, failed: true });
  });
});
