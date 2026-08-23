// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { DropdownMenuItem } from "@appstrate/ui/components/dropdown-menu";
import { TableRowActions } from "../table-row-actions.tsx";
import { render } from "./run-fixture.tsx";

describe("TableRowActions", () => {
  it("names the direct and overflow actions", () => {
    const html = render(
      <TableRowActions
        primary={{ label: "Modifier", onSelect: () => {} }}
        menuLabel="Plus d’actions pour Tractr"
      >
        <DropdownMenuItem>Supprimer</DropdownMenuItem>
      </TableRowActions>,
    );

    expect(html).toContain('aria-label="Modifier"');
    expect(html).toContain('aria-label="Plus d’actions pour Tractr"');
    expect(html).toContain("relative z-10");
  });

  it("does not draw an empty overflow trigger", () => {
    const html = render(<TableRowActions primary={{ label: "Modifier", onSelect: () => {} }} />);

    expect(html).toContain('aria-label="Modifier"');
    expect(html).not.toContain("MoreHorizontal");
    expect(html.match(/<button/g)).toHaveLength(1);
  });

  it("shows pending state on the row and locks its actions", () => {
    const html = render(
      <TableRowActions
        primary={{ label: "Modifier", onSelect: () => {} }}
        menuLabel="Plus d’actions"
        isPending
        pendingLabel="Enregistrement…"
      >
        <DropdownMenuItem>Supprimer</DropdownMenuItem>
      </TableRowActions>,
    );

    expect(html).toContain('aria-label="Enregistrement…"');
    expect(html.match(/disabled=""/g)).toHaveLength(2);
    expect(html).toContain('role="status"');
  });
});
