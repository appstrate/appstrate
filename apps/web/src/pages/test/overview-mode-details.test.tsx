// SPDX-License-Identifier: Apache-2.0

/**
 * « Tous les espaces » on the surfaces of one resource and on the shell: the sidebar counts the
 * runs of every reached space, the integration header's « Activer » names or asks the space.
 */

import { describe, expect, it } from "bun:test";
import type { ReactElement } from "react";
import { QueryClient } from "@tanstack/react-query";
import { SidebarProvider } from "@appstrate/ui/components/sidebar";
import { installSpaStorage } from "../../test/fake-storage.ts";

installSpaStorage({
  location: { pathname: "/", origin: "http://localhost" },
});

const { default: i18n, i18nReady } = await import("../../i18n.ts");
const { memberSpaceClient, renderInSpace, testSpace } = await import("../../test/space-context.ts");
const { NavOrg } = await import("../../components/nav-org.tsx");
const { IntegrationActivateButton } =
  await import("../../components/integration-detail/integration-activate-button.tsx");

await i18nReady;
await i18n.changeLanguage("fr");

const SPACES = [
  testSpace("spc_a", ["runs:read", "integrations:read", "integrations:install"], "Studio"),
  testSpace("spc_b", ["runs:read", "integrations:read", "integrations:install"], "Coffre"),
  testSpace("spc_c", ["runs:read", "integrations:read"], "Atelier"),
];

function renderIn(
  overview: boolean,
  node: ReactElement,
  seed: (queryClient: QueryClient) => void = () => {},
) {
  const queryClient = memberSpaceClient(SPACES);
  seed(queryClient);
  const html = renderInSpace(<SidebarProvider>{node}</SidebarProvider>, { overview, queryClient });
  const asked = (root: string) =>
    queryClient
      .getQueryCache()
      .findAll({ queryKey: [root] })
      .filter((query) => (query.options as { enabled?: unknown }).enabled !== false)
      .map((query) => query.queryKey);
  return { html, asked };
}

describe("the sidebar's Runs entry", () => {
  it("counts unread and running runs across the spaces in the mode, the runs page's own query", () => {
    const keys = renderIn(true, <NavOrg />).asked("paginated-runs");
    expect(keys.length).toBe(2);
    expect(keys.every((key) => key[1] === "org_1" && key[2] === "across-spaces")).toBe(true);
    // The unread count (`unread: true`) and the runs in flight (`status: pending,running`).
    expect(keys.some((key) => key[7] === true)).toBe(true);
    expect(keys.some((key) => key[6] === "pending,running")).toBe(true);
  });

  it("counts the working space's out of the mode", () => {
    const keys = renderIn(false, <NavOrg />).asked("paginated-runs");
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((key) => key[2] === "spc_a")).toBe(true);
  });
});

describe("an integration header's « Activer »", () => {
  const row = (activation: { spaceId: string; activate: string }[], active: string[] = []) => ({
    spaces: SPACES.map(({ id, name }) => ({ id, name })),
    packages: {
      agent: [],
      skill: [],
      integration: [
        {
          id: "@acme/crm",
          placements: active.map((spaceId) => ({
            space_id: spaceId,
            via: "home",
            state: "active",
          })),
          activation: activation.map((cell) => ({ ...cell, deactivate: cell.activate })),
        },
      ],
    },
  });
  const seed = (library: ReturnType<typeof row>) => (qc: QueryClient) => {
    qc.setQueryData(
      ["get", "/api/library", { params: { header: { "X-Org-Id": "org_1" } } }],
      library,
    );
    qc.setQueryData(
      [
        "get",
        "/api/spaces/{id}/library",
        { params: { path: { id: "spc_a" }, header: { "X-Org-Id": "org_1" } } },
      ],
      library,
    );
  };
  const button = (overview: boolean, library: ReturnType<typeof row>, activeHere = false) =>
    renderIn(
      overview,
      <IntegrationActivateButton packageId="@acme/crm" activeHere={activeHere} />,
      seed(library),
    ).html;

  it("is one click naming the one space it may switch it on in, in the mode", () => {
    const html = button(
      true,
      row(
        [
          { spaceId: "spc_a", activate: "allowed" },
          { spaceId: "spc_b", activate: "allowed" },
          { spaceId: "spc_c", activate: "forbidden" },
        ],
        ["spc_a"],
      ),
      true,
    );
    expect(html).toContain("Activer dans Coffre<");
    expect(html).not.toContain("aria-haspopup");
  });

  it("opens the menu of the spaces when several are eligible, in the mode", () => {
    const html = button(
      true,
      row([
        { spaceId: "spc_a", activate: "allowed" },
        { spaceId: "spc_b", activate: "allowed" },
      ]),
    );
    expect(html).toContain("Activer dans…<");
    expect(html).toContain('aria-haspopup="menu"');
  });

  it("is not drawn in the mode when no space is left to switch it on in", () => {
    const html = button(true, row([{ spaceId: "spc_a", activate: "allowed" }], ["spc_a"]), true);
    expect(html).not.toContain("detail-activate-btn");
  });

  it("switches the working space on out of the mode, and is gone once it is on", () => {
    const library = row([{ spaceId: "spc_a", activate: "allowed" }]);
    const off = button(false, library);
    expect(off).toContain('data-testid="detail-activate-btn"');
    expect(off).toContain(">Activer<");
    expect(button(false, library, true)).not.toContain("detail-activate-btn");
  });
});
