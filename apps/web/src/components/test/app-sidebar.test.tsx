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

describe("the notification bell on a phone", () => {
  const render = (product: "studio" | "chat") =>
    renderInSpace(
      <SidebarProvider>
        <AppSidebar product={product} />
      </SidebarProvider>,
      { overview: false, queryClient: memberSpaceClient([testSpace("spc_a", ["runs:read"])]) },
    );

  it("is in the chat's drawer, which has no bell in its header to carry one, and only there", () => {
    const chat = render("chat");
    expect(chat).toContain('aria-label="Notifications"');
    expect(chat).toMatch(/<div class="shrink-0 md:hidden"><[^>]*aria-label="Notifications"/);
    // Studio's header keeps its own.
    expect(render("studio")).not.toContain('aria-label="Notifications"');
  });

  it("goes with a close button, as the chat's drawer is the whole screen on a phone", () => {
    expect(render("chat")).toContain('data-testid="sidebar-close"');
    expect(render("studio")).not.toContain('data-testid="sidebar-close"');
  });
});
