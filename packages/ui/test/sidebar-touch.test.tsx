// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  mobileSidebarWidth,
  SidebarMenuButton,
  SidebarProvider,
} from "../src/components/sidebar.tsx";

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

describe("the phone sidebar's width", () => {
  it("is a drawer of 18 rem, or the whole screen when a product asks for it", () => {
    expect(mobileSidebarWidth(false)).toBe("18rem");
    expect(mobileSidebarWidth(true)).toBe("100vw");
  });
});
