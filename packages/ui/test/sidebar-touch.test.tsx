// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SidebarMenuButton, SidebarProvider } from "../src/components/sidebar.tsx";

describe("SidebarMenuButton", () => {
  it("keeps 44 px rows until a wide screen has a fine pointer", () => {
    const html = renderToStaticMarkup(
      <SidebarProvider>
        <SidebarMenuButton>Catalogue</SidebarMenuButton>
      </SidebarProvider>,
    );
    const button = html.match(/<button[^>]*data-sidebar="menu-button"[^>]*>/)?.[0] ?? "";
    expect(button).toContain("h-11");
    expect(button).toContain("desktop-pointer:h-8");
  });
});
