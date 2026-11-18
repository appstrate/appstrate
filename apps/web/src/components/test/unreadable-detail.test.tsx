// SPDX-License-Identifier: Apache-2.0

/**
 * A detail page the working space cannot read: out of « Tous les espaces », or for a failure that
 * is no refusal, it says so; in the mode it waits for the look-up across spaces, reopens where the
 * resource is (rendering nothing on its way: `Navigate` acts in an effect), and says it is
 * unavailable in none of the reader's spaces only when no reached space holds it. Where it reopens
 * is `detailElsewhere`.
 */

import { describe, expect, it } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
  location: { pathname: "/" },
});

const { $api, ApiError } = await import("../../api/client.ts");
const { detailElsewhere, UnreadableDetail } = await import("../unreadable-detail.tsx");
const { renderInSpace } = await import("../../test/space-context.ts");
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
  agent?: { version?: boolean };
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
  return renderInSpace(
    <UnreadableDetail
      kind={options.agent ? "agent" : "run"}
      id={options.agent ? "@acme/a" : "run_1"}
      version={options.agent?.version}
      error={options.error === undefined ? refused : options.error}
      pending={<span>{PENDING}</span>}
    />,
    {
      overview: options.overview,
      orgId: ORG_ID,
      spaceId: "spc_hidden",
      userId: "u_detail",
      queryClient,
      initialEntries: ["/agents/@acme/a/runs/run_1?journalFilter=tools"],
    },
  );
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

  it("looks a resource read as nothing (a 404 answered `null`) up across spaces", () => {
    expect(detail({ overview: true, error: null })).toContain(PENDING);
  });

  it("locates the live agent with launch-only sight and a version only with full read", () => {
    const placements =
      (readable: boolean, currentPlaced = true) =>
      (qc: QueryClient) => {
        qc.setQueryData(
          $api.queryOptions("get", "/api/packages/{scope}/{name}/home", {
            params: {
              path: { scope: "@acme", name: "a" },
              header: { "X-Org-Id": ORG_ID, "X-Space-Id": "spc_hidden" },
            },
          }).queryKey,
          {
            id: "@acme/a",
            type: "agent",
            read_space_ids: currentPlaced ? ["spc_other", "spc_hidden"] : ["spc_other"],
          },
        );
        qc.setQueryData(
          $api.queryOptions("get", "/api/spaces", {
            params: { header: { "X-Org-Id": ORG_ID } },
          }).queryKey,
          {
            data: [
              { ...SPACES[0], permissions: ["agents:run"] },
              { ...SPACES[1], permissions: [readable ? "agents:read" : "agents:run"] },
            ],
          },
        );
      };
    expect(detail({ overview: true, agent: {}, seed: placements(false, false) })).toBe("");
    // The home lookup ranks the other placement first. A summary-only read in the
    // current space must not skip a historical version that is readable there.
    expect(detail({ overview: true, agent: { version: true }, seed: placements(true) })).toBe("");
    expect(detail({ overview: true, agent: { version: true }, seed: placements(false) })).toContain(
      HINT_ACROSS(),
    );
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

describe("detailElsewhere", () => {
  const target = "/agents/@acme/a?agentSettings=connections#settings";
  const placements = ["spc_b", "spc_c"];
  const open = () => true;

  it("keeps the page, query and hash, entering the next enterable placement after the refusal", () => {
    expect(detailElsewhere(placements, target, "spc_a", open)).toBe(
      "/agents/@acme/a?agentSettings=connections&enterSpace=spc_b#settings",
    );
    const inC = "/agents/@acme/a?agentSettings=connections&enterSpace=spc_c#settings";
    expect(detailElsewhere(placements, target, "spc_b", open)).toBe(inC);
    expect(detailElsewhere(placements, target, "spc_a", (id) => id !== "spc_b")).toBe(inC);
  });

  it("stops after the last refusal, or before the working space resolves", () => {
    expect(detailElsewhere(placements, target, "spc_c", open)).toBeNull();
    expect(detailElsewhere(placements, target, null, open)).toBeNull();
  });
});
