// SPDX-License-Identifier: Apache-2.0

/**
 * A dropdown menu and a popover pick their container from the width: from `md` up the Radix menu
 * and popover, below a panel from the bottom. A portal renders nothing under
 * `renderToStaticMarkup`, so what shows is the trigger and, on a phone, the rows (a sheet's rows
 * need no menu context, a Radix item does).
 */

import { afterEach, describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../src/components/dropdown-menu.tsx";
import { Popover, PopoverAnchor, PopoverTrigger } from "../src/components/popover.tsx";

const globals = globalThis as { window?: unknown };

/** The width `useIsMobile` reads on its first render. */
function viewport(width: number): void {
  globals.window = { innerWidth: width };
}

afterEach(() => {
  delete globals.window;
});

describe("DropdownMenu", () => {
  it("opens a menu from its trigger from md up", () => {
    viewport(1280);
    const out = renderToStaticMarkup(
      <DropdownMenu>
        <DropdownMenuTrigger>Actions</DropdownMenuTrigger>
      </DropdownMenu>,
    );
    expect(out).toContain('aria-haspopup="menu"');
  });

  it("opens a panel from the bottom below md", () => {
    viewport(375);
    const out = renderToStaticMarkup(
      <DropdownMenu>
        <DropdownMenuTrigger>Actions</DropdownMenuTrigger>
      </DropdownMenu>,
    );
    expect(out).toContain('aria-haspopup="dialog"');
  });

  it("draws an item as a 48 px button row below md, disabled and destructive kept", () => {
    viewport(375);
    const out = renderToStaticMarkup(
      <DropdownMenu>
        <DropdownMenuItem className="text-destructive">Delete</DropdownMenuItem>
        <DropdownMenuItem disabled>Rename</DropdownMenuItem>
      </DropdownMenu>,
    );
    expect(out).toMatch(/<button type="button"[^>]*class="[^"]*min-h-12[^"]*text-destructive/);
    expect(out).toMatch(/<button type="button" disabled=""[^>]*aria-disabled="true"/);
  });

  it("says a checkbox item's state below md", () => {
    viewport(375);
    const out = renderToStaticMarkup(
      <DropdownMenu>
        <DropdownMenuCheckboxItem checked>Studio</DropdownMenuCheckboxItem>
      </DropdownMenu>,
    );
    expect(out).toContain('role="checkbox"');
    expect(out).toContain('aria-checked="true"');
  });

  it("lists a sub-menu's rows under its trigger's words below md", () => {
    viewport(375);
    const out = renderToStaticMarkup(
      <DropdownMenu>
        <DropdownMenuLabel>Account</DropdownMenuLabel>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Theme</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem>Dark</DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenu>,
    );
    const heading = out.match(/<div id="([^"]+)"[^>]*>Theme<\/div>/);
    expect(heading).not.toBeNull();
    expect(out).toContain(`role="group" aria-labelledby="${heading?.[1]}"`);
    expect(out).toMatch(/role="group"[^>]*><button[^>]*>Dark<\/button>/);
  });
});

describe("Popover", () => {
  it("keeps the anchor's own element below md, where nothing lines up with it", () => {
    viewport(375);
    const out = renderToStaticMarkup(
      <Popover>
        <PopoverAnchor render={<div className="row" />}>
          <PopoverTrigger>Settings</PopoverTrigger>
        </PopoverAnchor>
      </Popover>,
    );
    expect(out).toMatch(/<div class="row"><button type="button"[^>]*aria-haspopup="dialog"/);
  });
});
