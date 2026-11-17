// SPDX-License-Identifier: Apache-2.0

/**
 * « Tous les espaces » on the surfaces of one resource and on the shell: a skill's or an
 * integration's header names the spaces it is active in, the sidebar counts the runs of every
 * reached space, the integration's activation asks the space, and a link entering a space from an
 * overlay is read off the address bar, not off the page drawn beneath it.
 */

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient } from "@tanstack/react-query";
import { SidebarProvider } from "@appstrate/ui/components/sidebar";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
  location: { pathname: "/", origin: "http://localhost" },
});

const { render } = await import("../../test/render.tsx");
const { default: i18n, i18nReady } = await import("../../i18n.ts");
const { orgStore } = await import("../../stores/org-store.ts");
const { spaceStore } = await import("../../stores/space-store.ts");
const { authStore } = await import("../../stores/auth-store.ts");
const { overviewStore } = await import("../../stores/overview-store.ts");
const { NavOrg } = await import("../../components/nav-org.tsx");
const { PackageDetailSpaces } = await import("../../components/package-spaces.tsx");
const { useActivationChoice } = await import("../../hooks/use-activation-choice.ts");
const { linkedSpaceIn } = await import("../../hooks/use-current-space.ts");
const { useOverlayState, withBackground } = await import("../../lib/modal-route.ts");

await i18nReady;
await i18n.changeLanguage("fr");

const space = (id: string, name: string, permissions: string[]) => ({
  id,
  object: "space",
  access: "member",
  permissions,
  personal: false,
  isDefault: id === "spc_a",
  name,
  role: null,
});
const SPACES = [
  space("spc_a", "Studio", ["runs:read", "integrations:read", "integrations:install"]),
  space("spc_b", "Coffre", ["runs:read", "integrations:read", "integrations:install"]),
  space("spc_c", "Atelier", ["runs:read", "integrations:read"]),
];

let stubs: { mockRestore: () => void }[] = [];
afterEach(() => {
  for (const stub of stubs) stub.mockRestore();
  stubs = [];
});

function renderIn(
  overview: boolean,
  node: ReactElement,
  seed: (queryClient: QueryClient) => void = () => {},
) {
  stubs = [
    spyOn(orgStore, "getInitialState").mockReturnValue({
      ...orgStore.getInitialState(),
      id: "org_1",
    }),
    spyOn(spaceStore, "getInitialState").mockReturnValue({
      ...spaceStore.getInitialState(),
      id: "spc_a",
    }),
    spyOn(authStore, "getInitialState").mockReturnValue({
      ...authStore.getInitialState(),
      user: { id: "u_1", email: "u@example.test", emailVerified: true },
    }),
    spyOn(overviewStore, "getInitialState").mockReturnValue({
      ...overviewStore.getInitialState(),
      chosen: overview ? { "u_1:org_1": true } : {},
    }),
  ];
  const queryClient = new QueryClient();
  queryClient.setQueryData(
    ["get", "/api/spaces", { params: { header: { "X-Org-Id": "org_1" } } }],
    { object: "list", hasMore: false, data: SPACES },
  );
  seed(queryClient);
  const html = render(<SidebarProvider>{node}</SidebarProvider>, { queryClient });
  const asked = (root: string) =>
    queryClient
      .getQueryCache()
      .findAll({ queryKey: [root] })
      .filter((query) => (query.options as { enabled?: unknown }).enabled !== false)
      .map((query) => query.queryKey);
  return { html, asked };
}

describe("a package header", () => {
  it("names the spaces it is active in, its home first and the others counted", () => {
    const { html } = renderIn(
      false,
      <PackageDetailSpaces
        detail={{ homeSpaceId: "spc_b", spaceIds: ["spc_b", "spc_a"], source: "local" }}
      />,
    );
    expect(html).toContain(">Coffre<");
    expect(html).toContain("+1");
  });
});

describe("the sidebar's Runs entry", () => {
  it("counts unread and running runs across the spaces in the mode, the runs page's own query", () => {
    const keys = renderIn(true, <NavOrg />).asked("paginated-runs");
    expect(keys.length).toBe(2);
    expect(keys.every((key) => key[1] === "org_1" && key[2] === "across-spaces")).toBe(true);
    // The unread count (`unread: true`) and the running one (`status: running`).
    expect(keys.some((key) => key[7] === true)).toBe(true);
    expect(keys.some((key) => key[6] === "running")).toBe(true);
  });

  it("counts the working space's out of the mode", () => {
    const keys = renderIn(false, <NavOrg />).asked("paginated-runs");
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((key) => key[2] === "spc_a")).toBe(true);
  });
});

describe("an integration's activation in the mode", () => {
  const library = {
    spaces: [],
    packages: {
      agent: [],
      skill: [],
      integration: [
        {
          id: "@acme/crm",
          placements: [{ space_id: "spc_a", via: "home", state: "active" }],
          activation: [
            { spaceId: "spc_a", activate: "allowed", deactivate: "allowed" },
            { spaceId: "spc_b", activate: "allowed", deactivate: "allowed" },
            { spaceId: "spc_c", activate: "forbidden", deactivate: "forbidden" },
          ],
        },
      ],
    },
  };
  function Probe() {
    const choice = useActivationChoice("integration", "@acme/crm");
    return <p>{choice ? `${choice.label} ${choice.spaces.map((s) => s.id).join(",")}` : "none"}</p>;
  }
  const seedLibrary = (qc: QueryClient) =>
    qc.setQueryData(
      ["get", "/api/library", { params: { header: { "X-Org-Id": "org_1" } } }],
      library,
    );

  it("asks among the spaces where it is off and the reader may switch it on", () => {
    expect(renderIn(true, <Probe />, seedLibrary).html).toContain("Activer dans… spc_b<");
  });

  it("asks nothing out of the mode: the working space's switch answers", () => {
    expect(renderIn(false, <Probe />, seedLibrary).html).toContain(">none<");
  });
});

describe("a link entering a space from an overlay (`?enterSpace=`)", () => {
  /** What the page tree sees: rendered under `<Routes location={page}>`, as `MainLayout` is. */
  function PageProbe({ address }: { address: string }) {
    const { search } = useLocation();
    return <p>{`address:${linkedSpaceIn(address)} page:${linkedSpaceIn(search)}`}</p>;
  }
  /** App's split: the address bar's location outside, the page's within. */
  function Shell() {
    const location = useLocation();
    const { page } = useOverlayState();
    return (
      <Routes location={page}>
        <Route path="*" element={<PageProbe address={location.search} />} />
      </Routes>
    );
  }

  it("is read off the address bar: the page beneath the overlay does not carry it", () => {
    const entry = {
      pathname: "/catalogue/agents",
      search: "?enterSpace=spc_b",
      state: withBackground(null, {
        location: { pathname: "/agents", search: "", hash: "", state: null, key: "bg" },
        index: null,
      }),
    };
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={[entry]}>
        <Shell />
      </MemoryRouter>,
    );
    expect(html).toContain("address:spc_b");
    expect(html).toContain("page:null");
  });
});
