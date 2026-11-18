// SPDX-License-Identifier: Apache-2.0

/**
 * A detail page the working space cannot read: out of « Tous les espaces », or for a failure that
 * is no refusal, it says so; in the mode it waits for the look-up across spaces, reopens where the
 * resource is (rendering nothing on its way: `Navigate` acts in an effect), and says it is
 * unavailable in none of the reader's spaces only when no reached space holds it. Where it reopens
 * is `detailElsewhere`'s (`lib/across-spaces.ts`).
 */

import { describe, expect, it } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
  location: { pathname: "/" },
});

const { $api, ApiError } = await import("../../api/client.ts");
const { UnreadableDetail } = await import("../unreadable-detail.tsx");
const { memberSpaceClient, renderInSpace, testSpace } = await import("../../test/space-context.ts");
const i18nModule = await import("../../i18n.ts");
await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");
const i18n = i18nModule.default;

const ORG_ID = "org_1";
const GRANTS = ["runs:read", "agents:read"];
const SPACES = [testSpace("spc_hidden", GRANTS), testSpace("spc_other", GRANTS)];
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
  const queryClient = memberSpaceClient(SPACES);
  // A look-up seeded as failed stays failed: no retry on mount.
  queryClient.setDefaultOptions({ queries: { retryOnMount: false } });
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
      spaceId: "spc_hidden",
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
