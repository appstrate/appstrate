// SPDX-License-Identifier: Apache-2.0

/**
 * A detail page the working space cannot read: out of « Tous les espaces », or for a failure that
 * is no refusal, it says so; in the mode it waits for the look-up across spaces, reopens where the
 * resource is (rendering nothing on its way: `Navigate` acts in an effect), and says it is
 * unavailable in none of the reader's spaces only when no reached space holds it. Where it reopens
 * is `detailElsewhere` (`lib/test/detail-elsewhere.test.ts`).
 */

import { describe, expect, it, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
  location: { pathname: "/" },
});

const { $api, ApiError } = await import("../../api/client.ts");
const { UnreadableDetail } = await import("../unreadable-detail.tsx");
const { orgStore } = await import("../../stores/org-store.ts");
const { spaceStore } = await import("../../stores/space-store.ts");
const { authStore } = await import("../../stores/auth-store.ts");
const { overviewStore } = await import("../../stores/overview-store.ts");
const { render } = await import("../../test/render.tsx");
const i18nModule = await import("../../i18n.ts");
await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");
const i18n = i18nModule.default;

const ORG_ID = "org_detail";
const space = (id: string) => ({
  id,
  access: "member",
  permissions: ["runs:read", "agents:read"],
  personal: false,
  isDefault: id === "spc_hidden",
  name: id,
});
const SPACES = [space("spc_hidden"), space("spc_other")];
const RUN_PATH = "/api/orgs/{orgId}/runs/{id}" as const;
const runKey = $api.queryOptions("get", RUN_PATH, {
  params: { path: { orgId: ORG_ID, id: "run_1" } },
}).queryKey;

const PENDING = "PAGE-SKELETON";
const refused = new ApiError("not_found", "not here", 404);

function detail(options: {
  overview: boolean;
  error?: unknown;
  seed?: (qc: QueryClient) => void;
}): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  queryClient.setQueryData(
    ["orgs"],
    [{ id: ORG_ID, name: "Org", slug: "org", role: "owner", permissions: [] }],
  );
  queryClient.setQueryData(
    $api.queryOptions("get", "/api/spaces", { params: { header: { "X-Org-Id": ORG_ID } } })
      .queryKey,
    { object: "list", hasMore: false, data: SPACES },
  );
  options.seed?.(queryClient);
  const stubs = [
    spyOn(orgStore, "getInitialState").mockReturnValue({
      ...orgStore.getInitialState(),
      id: ORG_ID,
    }),
    spyOn(spaceStore, "getInitialState").mockReturnValue({
      ...spaceStore.getInitialState(),
      id: "spc_hidden",
    }),
    spyOn(authStore, "getInitialState").mockReturnValue({
      ...authStore.getInitialState(),
      user: { id: "u_detail", email: "u@example.test", emailVerified: true },
    }),
    spyOn(overviewStore, "getInitialState").mockReturnValue({
      ...overviewStore.getInitialState(),
      chosen: options.overview ? { [`u_detail:${ORG_ID}`]: true } : {},
    }),
  ];
  try {
    return render(
      <UnreadableDetail
        kind="run"
        id="run_1"
        error={options.error === undefined ? refused : options.error}
        pending={<span>{PENDING}</span>}
      />,
      { queryClient, initialEntries: ["/agents/@acme/a/runs/run_1?journalFilter=tools"] },
    );
  } finally {
    for (const stub of stubs) stub.mockRestore();
  }
}

const UNAVAILABLE = () => i18n.t("common:error.resourceUnavailable");
const HINT_HERE = () => i18n.t("common:error.resourceUnavailableHint");
const HINT_ACROSS = () => i18n.t("common:error.resourceUnavailableHintAcross");

describe("UnreadableDetail", () => {
  it("says the resource is unavailable in this space out of the mode", () => {
    const html = detail({ overview: false });
    expect(html).toContain(UNAVAILABLE());
    expect(html).toContain(HINT_HERE());
  });

  it("shows a failure that is no refusal as it is, in the mode too", () => {
    const html = detail({ overview: true, error: new ApiError("internal", "boom", 500) });
    expect(html).not.toContain(UNAVAILABLE());
    expect(html).not.toContain(PENDING);
  });

  it("waits for the look-up across spaces with the page's own skeleton", () => {
    expect(detail({ overview: true })).toContain(PENDING);
  });

  it("says unavailable in none of the reader's spaces when the look-up failed", () => {
    const html = detail({
      overview: true,
      seed: (qc) =>
        qc
          .getQueryCache()
          .build(qc, { queryKey: runKey })
          .setState({ status: "error", error: refused, fetchStatus: "idle" }),
    });
    expect(html).toContain(UNAVAILABLE());
    expect(html).toContain(HINT_ACROSS());
    expect(html).not.toContain(HINT_HERE());
  });

  it("reopens in the space holding it, drawing nothing on the way", () => {
    const html = detail({
      overview: true,
      seed: (qc) => qc.setQueryData(runKey, { id: "run_1", spaceId: "spc_other" }),
    });
    expect(html).toBe("");
  });

  it("says unavailable when the space holding it is the one that just refused", () => {
    const html = detail({
      overview: true,
      seed: (qc) => qc.setQueryData(runKey, { id: "run_1", spaceId: "spc_hidden" }),
    });
    expect(html).toContain(HINT_ACROSS());
  });
});
