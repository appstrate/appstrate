// SPDX-License-Identifier: Apache-2.0

/**
 * The shell's header, one for every product and format: while the sidebar is off screen it opens
 * from one control (a burger and the organization's and the space's avatars, no names). Below
 * `md` the bell is the drawer's, and that control carries its unread dot.
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

const { renderInSpace, memberSpaceClient, testSpace } = await import("../../test/space-context.ts");
const { default: i18n, i18nReady } = await import("../../i18n.ts");
const { ShellHeader } = await import("../app-shell.tsx");
const { ShellFrameProvider } = await import("../shell-header-slots.tsx");

await i18nReady;
await i18n.changeLanguage("fr");

/** The header in spc_a, with `unreadNotifications` waiting behind the bell. */
function render({ unreadNotifications = 0 }: { unreadNotifications?: number } = {}) {
  const queryClient = memberSpaceClient([testSpace("spc_a", ["runs:read"], "Sales")]);
  queryClient.setQueryData(
    [
      "get",
      "/api/notifications/unread-count",
      { params: { header: { "X-Org-Id": "org_1", "X-Space-Id": "spc_a" } } },
    ],
    { count: unreadNotifications },
  );
  return renderInSpace(
    <SidebarProvider>
      <ShellFrameProvider>
        <ShellHeader />
      </ShellFrameProvider>
    </SidebarProvider>,
    { queryClient, overview: false },
  );
}

/** The header as a phone draws it (`useIsMobile` reads the window's width). */
function renderOnPhone(options?: Parameters<typeof render>[0]) {
  const win = window as unknown as { innerWidth?: number };
  win.innerWidth = 390;
  try {
    return render(options);
  } finally {
    delete win.innerWidth;
  }
}

const openerOf = (html: string) =>
  html.match(/<button[^>]*data-testid="sidebar-opener"[^>]*>[\s\S]*?<\/button>/)?.[0] ?? "";

describe("the shell header", () => {
  it("opens the sidebar from one control on a phone, named with where the user stands", () => {
    const html = render();
    expect(html.match(/<header/g)).toHaveLength(1);
    const opener = html.match(/<button[^>]*data-testid="sidebar-opener"[^>]*>/)?.[0] ?? "";
    // Below md only while the desktop sidebar is open; 44 px on touch.
    expect(opener).toMatch(/class="[^"]*md:hidden/);
    expect(opener).toContain("h-11");
    expect(opener).toMatch(/aria-label="Afficher ou masquer le menu latéral \(Acme, [^"]+\)"/);
    // The avatars are stacked as in the sidebar's switcher: the space's is a badge on the corner of
    // the organization's, not a second tile beside it.
    expect(html).toContain("absolute -right-1 -bottom-1 size-4");
  });

  it("keeps the bell in the header from md up only: below, the drawer holds it", () => {
    const bell = render().match(/<button[^>]*aria-label="Notifications"[^>]*>/)?.[0] ?? "";
    expect(bell).toMatch(/class="[^"]*max-md:hidden/);
  });

  it("puts a dot on the burger for unread notifications on a phone, and says how many", () => {
    const opener = openerOf(renderOnPhone({ unreadNotifications: 2 }));
    expect(opener).toMatch(/aria-label="[^"]*, 2 notifications non lues"/);
    expect(opener).toContain("bg-destructive");
  });

  it("leaves the notifications to the bell where the header shows it", () => {
    const opener = openerOf(render({ unreadNotifications: 2 }));
    expect(opener).not.toContain("notification");
    expect(opener).not.toContain("bg-destructive");
  });

  it("draws no dot on a phone with nothing unread", () => {
    expect(openerOf(renderOnPhone())).not.toContain("bg-destructive");
  });
});
