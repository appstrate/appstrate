// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SidebarMenuButton, SidebarProvider } from "../src/components/sidebar.tsx";

describe("SidebarMenuButton", () => {
  it("is 44 px tall below md (the drawer of a phone) and 32 px from md", () => {
    const html = renderToStaticMarkup(
      <SidebarProvider>
        <SidebarMenuButton>Catalogue</SidebarMenuButton>
      </SidebarProvider>,
    );
    const button = html.match(/<button[^>]*data-sidebar="menu-button"[^>]*>/)?.[0] ?? "";
    expect(button).toContain("h-8");
    expect(button).toContain("max-md:h-11");
  });
});
