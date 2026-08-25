// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { DropdownMenuItem } from "@appstrate/ui/components/dropdown-menu";
import { PageActionsMenu } from "../page-actions-menu.tsx";
import { render } from "./run-fixture.tsx";

describe("PageActionsMenu", () => {
  it("keeps one labelled trigger at every width instead of rendering deeds directly", () => {
    const html = render(
      <PageActionsMenu>
        <DropdownMenuItem data-page-action="create">Create</DropdownMenuItem>
      </PageActionsMenu>,
    );

    expect(html.match(/data-page-actions-trigger/g)).toHaveLength(1);
    expect(html).toContain("Actions");
    expect(html).not.toContain("hidden sm:inline");
  });
});
