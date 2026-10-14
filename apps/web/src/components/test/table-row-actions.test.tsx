// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { DropdownMenuItem } from "@appstrate/ui/components/dropdown-menu";
import { TableRowActions } from "../table-row-actions.tsx";
import i18n, { i18nReady } from "../../i18n.ts";
import { render } from "../../test/render.tsx";

await i18nReady;
await i18n.changeLanguage("fr");

describe("TableRowActions", () => {
  it("is one « … » menu and nothing beside it", () => {
    const html = render(
      <TableRowActions menuLabel="Plus d’actions pour Acme">
        <DropdownMenuItem>Modifier</DropdownMenuItem>
        <DropdownMenuItem>Supprimer</DropdownMenuItem>
      </TableRowActions>,
    );

    expect(html).toContain('aria-label="Plus d’actions pour Acme"');
    expect(html).toContain("relative z-10");
    expect(html.match(/<button/g)).toHaveLength(1);
  });

  it("does not draw an empty overflow trigger", () => {
    expect(render(<TableRowActions menuLabel="Plus d’actions" />)).not.toContain("<button");
    expect(
      render(<TableRowActions>{<DropdownMenuItem>Modifier</DropdownMenuItem>}</TableRowActions>),
    ).not.toContain("<button");
  });

  it("shows pending state on the row and locks its menu", () => {
    const html = render(
      <TableRowActions menuLabel="Plus d’actions" isPending pendingLabel="Enregistrement…">
        <DropdownMenuItem>Supprimer</DropdownMenuItem>
      </TableRowActions>,
    );

    expect(html).toContain('aria-label="Enregistrement…"');
    expect(html.match(/disabled=""/g)).toHaveLength(1);
    expect(html).toContain('role="status"');
  });
});
