// SPDX-License-Identifier: Apache-2.0

/**
 * The shell's header on a phone: the chat has its own (a burger and the organization's and the
 * space's avatars, no names, no bell) and the shell's is for desktop; Studio keeps the shell's.
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

function render(product: "studio" | "chat") {
  return renderInSpace(
    <SidebarProvider>
      <ShellFrameProvider>
        <ShellHeader product={product} />
      </ShellFrameProvider>
    </SidebarProvider>,
    {
      queryClient: memberSpaceClient([testSpace("spc_a", ["runs:read"], "Sales")]),
      overview: false,
    },
  );
}

describe("the shell header on a phone", () => {
  it("gives the chat its own header, hidden from md, and hides the shell's below md", () => {
    const html = render("chat");
    expect(html).toContain('data-testid="chat-phone-header"');
    const phone = html.split("</header>")[0] ?? "";
    expect(phone).toMatch(/class="[^"]*md:hidden/);
    // The one control that opens the sidebar is a burger, named for a screen reader with where the
    // user stands: the organization and the space.
    expect(phone).toContain('data-testid="chat-sidebar-trigger"');
    expect(phone).toMatch(/aria-label="Afficher ou masquer le menu latéral \(Acme, [^"]+\)"/);
    expect(phone).toContain("h-11");
    // The avatars are stacked as in the sidebar's switcher: the space's is a badge on the corner of
    // the organization's, not a second tile beside it.
    expect(phone).toContain("absolute -right-1 -bottom-1 size-4");
    expect(phone).toContain("ring-canvas");
    // The shell's own header is the rest of the markup, gone below md.
    expect(html.slice(phone.length)).toMatch(/<header class="[^"]*max-md:hidden/);
  });

  it("Studio uses the shell's header at every width", () => {
    const html = render("studio");
    expect(html).not.toContain('data-testid="chat-phone-header"');
    expect(html).not.toContain("max-md:hidden");
  });
});
