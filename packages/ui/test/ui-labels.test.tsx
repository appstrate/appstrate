// SPDX-License-Identifier: Apache-2.0

/**
 * A primitive rendered OUTSIDE a host that provides `UiLabelsContext` — a module's own modal
 * mounted on its own, a test — still has a label: the context's default is the English set,
 * never an empty string or a missing accessible name.
 */

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SidebarProvider, SidebarTrigger } from "../src/components/sidebar.tsx";
import { UiLabelsContext } from "../src/components/ui-labels.ts";

const trigger = (
  <SidebarProvider>
    <SidebarTrigger />
  </SidebarProvider>
);

describe("UiLabelsContext", () => {
  it("falls back to English without a provider", () => {
    expect(renderToStaticMarkup(trigger)).toContain("Toggle Sidebar");
  });

  it("renders the host's labels under a provider", () => {
    const html = renderToStaticMarkup(
      <UiLabelsContext.Provider
        value={{
          close: "Fermer",
          sidebar: "Menu latéral",
          sidebarDescription: "Affiche le menu latéral sur mobile.",
          toggleSidebar: "Afficher ou masquer le menu latéral",
        }}
      >
        {trigger}
      </UiLabelsContext.Provider>,
    );
    expect(html).toContain("Afficher ou masquer le menu latéral");
    expect(html).not.toContain("Toggle Sidebar");
  });
});
