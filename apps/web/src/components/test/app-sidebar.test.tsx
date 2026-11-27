// SPDX-License-Identifier: Apache-2.0

/**
 * The shell's entries are the same in and out of « Tous les espaces »: the catalogue names no
 * space (its add menu names each deed's), so its entry is judged as its page is, by the route's
 * verdict, and opens without asking for a space.
 */

import { afterAll, describe, expect, it } from "bun:test";
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
    querySelector: () => null,
    head: { appendChild() {} },
    createElement: () => ({ appendChild() {} }),
    createTextNode: () => ({}),
  },
});
afterAll(() => {
  if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
  else delete (globalThis as { document?: unknown }).document;
});

const { default: i18n, i18nReady } = await import("../../i18n.ts");
const { AppSidebar } = await import("../app-shell.tsx");
const { memberSpaceClient, renderInSpace, testSpace } = await import("../../test/space-context.ts");

await i18nReady;
await i18n.changeLanguage("fr");

/** The sidebar standing in spc_a, which reads the catalogue when `workingReads`; spc_b does. */
const sidebar = (overview: boolean, workingReads = false): string =>
  renderInSpace(
    <SidebarProvider>
      <AppSidebar product="studio" />
    </SidebarProvider>,
    {
      overview,
      queryClient: memberSpaceClient([
        testSpace("spc_a", ["runs:read", "agents:read", ...(workingReads ? ["spaces:read"] : [])]),
        testSpace("spc_b", ["runs:read", "spaces:read"]),
      ]),
    },
  );

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

describe("the sidebar of a role without the Studio", () => {
  it("offers the Catalogue in the chat: an overlay stands over both products", () => {
    const html = renderInSpace(
      <SidebarProvider>
        <AppSidebar product="chat" />
      </SidebarProvider>,
      {
        overview: false,
        queryClient: memberSpaceClient([
          testSpace("spc_a", ["chat:read", "spaces:read"], "Atelier", { studio: false }),
        ]),
      },
    );
    expect(catalogueShown(html)).toBe(true);
  });
});

describe("the drawer's head", () => {
  const render = (product: "studio" | "chat") =>
    renderInSpace(
      <SidebarProvider>
        <AppSidebar product={product} />
      </SidebarProvider>,
      { overview: false, queryClient: memberSpaceClient([testSpace("spc_a", ["runs:read"])]) },
    );

  it("closes from its own corner in every product, the drawer being the whole screen on a phone", () => {
    for (const product of ["chat", "studio"] as const) {
      expect(render(product)).toContain('data-testid="sidebar-close"');
    }
  });

  it("holds the bell below md, just before the close button", () => {
    for (const product of ["chat", "studio"] as const) {
      const html = render(product);
      const bell = html.match(/<button[^>]*aria-label="Notifications"[^>]*>/)?.[0] ?? "";
      expect(bell).toMatch(/class="[^"]*md:hidden/);
      expect(bell).not.toContain("max-md:hidden");
      expect(html.indexOf(bell)).toBeLessThan(html.indexOf('data-testid="sidebar-close"'));
    }
  });

  it("sizes the switcher to its names on a phone, its chevrons right after them", () => {
    const html = render("studio");
    const trigger = html.match(/<button[^>]*data-testid="org-switcher-button"[^>]*>/)?.[0] ?? "";
    // The sidebar's width from md up only.
    expect(trigger).toMatch(/class="[^"]*max-w-full md:w-full/);
    expect(trigger).not.toMatch(/class="[^"]*(?<![:\w-])w-full/);
    const names = html
      .slice(html.indexOf(trigger))
      .match(/<span class="([^"]*leading-tight[^"]*)"/)?.[1];
    expect(names?.split(" ")).toContain("md:flex-1");
    expect(names?.split(" ")).not.toContain("flex-1");
  });
});

describe("the drawer's footer", () => {
  const render = (product: "studio" | "chat") =>
    renderInSpace(
      <SidebarProvider>
        <AppSidebar product={product} />
      </SidebarProvider>,
      { overview: false, queryClient: memberSpaceClient([testSpace("spc_a", ["runs:read"])]) },
    );

  it("carries the same Settings entry in the chat as in Studio, on every format", () => {
    for (const product of ["chat", "studio"] as const) {
      const html = render(product);
      const entry = html.indexOf("<span>Paramètres</span>");
      expect(entry).toBeGreaterThan(-1);
      expect(html.slice(html.lastIndexOf("<ul", entry), entry)).not.toContain("max-md:hidden");
    }
  });
});
