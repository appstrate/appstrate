// SPDX-License-Identifier: Apache-2.0

/**
 * The shell's entries are the same in and out of « Tous les espaces »: the catalogue names no
 * space (its add menu names each deed's), so its entry is judged as its page is, by the route's
 * verdict, and opens without asking for a space.
 */

import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { SidebarProvider } from "@appstrate/ui/components/sidebar";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
  location: { pathname: "/", origin: "http://localhost" },
  matchMedia: () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }),
});

// The profile menu pulls in the theme store (paints `<html>` at import) and sonner (injects a
// `<style>` at import): a stub keeps both inert.
const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: {
    documentElement: { classList: { add() {}, remove() {} } },
    head: { appendChild() {} },
    createElement: () => ({ appendChild() {} }),
    createTextNode: () => ({}),
  },
});
afterAll(() => {
  if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
  else delete (globalThis as { document?: unknown }).document;
});

const { render } = await import("../../test/render.tsx");
const { default: i18n, i18nReady } = await import("../../i18n.ts");
const { AppSidebar } = await import("../app-shell.tsx");
const { orgStore } = await import("../../stores/org-store.ts");
const { spaceStore } = await import("../../stores/space-store.ts");
const { authStore } = await import("../../stores/auth-store.ts");
const { overviewStore } = await import("../../stores/overview-store.ts");

await i18nReady;
await i18n.changeLanguage("fr");

const space = (id: string, permissions: string[]) => ({
  id,
  object: "space",
  access: "member",
  permissions,
  personal: false,
  isDefault: id === "spc_a",
  name: id,
  role: null,
});

/** The sidebar standing in spc_a, which reads the catalogue when `workingReads`; spc_b does. */
function sidebar(overview: boolean, workingReads = false): string {
  const stubs = [
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
    ["orgs"],
    [
      {
        id: "org_1",
        name: "Acme",
        slug: "acme",
        icon: null,
        color: null,
        role: "member",
        deleting_at: null,
        permissions: [],
        createdAt: "2026-09-05T00:00:00Z",
      },
    ],
  );
  queryClient.setQueryData(
    ["get", "/api/spaces", { params: { header: { "X-Org-Id": "org_1" } } }],
    {
      object: "list",
      hasMore: false,
      data: [
        space("spc_a", ["runs:read", "agents:read", ...(workingReads ? ["spaces:read"] : [])]),
        space("spc_b", ["runs:read", "spaces:read"]),
      ],
    },
  );
  try {
    return render(
      <SidebarProvider>
        <AppSidebar product="studio" />
      </SidebarProvider>,
      { queryClient },
    );
  } finally {
    for (const stub of stubs) stub.mockRestore();
  }
}

/** Whether the Catalogue entry shows: its menu is always drawn, `hidden` when not offered. */
function catalogueShown(html: string): boolean {
  const entry = html.indexOf("<span>Catalogue</span>");
  const menu = html.slice(html.lastIndexOf("<ul", entry), entry);
  return entry >= 0 && !menu.slice(0, menu.indexOf(">")).includes("hidden");
}

describe("the sidebar in « Tous les espaces »", () => {
  it("offers the Catalogue where its route opens, in the mode as out of it", () => {
    for (const overview of [true, false]) {
      expect({ overview, shown: catalogueShown(sidebar(overview, true)) }).toEqual({
        overview,
        shown: true,
      });
      expect({ overview, shown: catalogueShown(sidebar(overview, false)) }).toEqual({
        overview,
        shown: false,
      });
    }
  });

  it("links it straight to the catalogue: no space is asked for", () => {
    expect(sidebar(true, true)).toContain('href="/catalogue/agent"');
  });
});
