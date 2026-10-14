// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { Fragment, isValidElement, type ReactElement, type ReactNode } from "react";
import { DropdownMenuSeparator } from "@appstrate/ui/components/dropdown-menu";
import type { DataColumn } from "../data-table.tsx";
import { useDocumentColumns } from "../document-columns.tsx";
import type { FileDto } from "../../hooks/use-files.ts";
import { documents } from "../../lab/fixtures.ts";
import i18n, { i18nReady } from "../../i18n.ts";
import { render } from "../../test/render.tsx";
import { textsOf } from "../../test/connection-menu-tree.tsx";

await i18nReady;
await i18n.changeLanguage("fr");

function columnsFrom<T>(useColumns: () => DataColumn<T>[]): DataColumn<T>[] {
  let captured: DataColumn<T>[] = [];
  function Probe() {
    captured = useColumns();
    return null;
  }
  render(<Probe />);
  return captured;
}

/** The row's « … » cell as rendered: the menu's trigger, or nothing. */
function actionCell<T>(columns: DataColumn<T>[], row: T): string {
  const actions = columns.find((column) => column.id === "actions");
  if (!actions) throw new Error("Missing Actions column");
  return render(<>{actions.cell(row)}</>);
}

/**
 * The entries of the row's « … » menu, in order (« — » for a separator). A Radix menu draws
 * its items in a portal a static render drops, so the menu's children are read from the
 * element the row's actions component returns.
 */
function menuEntries<T>(columns: DataColumn<T>[], row: T): string[] {
  const actions = columns.find((column) => column.id === "actions");
  if (!actions) throw new Error("Missing Actions column");
  const cell = actions.cell(row) as ReactElement<object>;
  let entries: string[] = [];
  function Probe() {
    const menu = (cell.type as (props: object) => ReactElement<{ children?: ReactNode }>)(
      cell.props,
    );
    entries = flatten(menu.props.children).map((item) =>
      item.type === DropdownMenuSeparator ? "—" : textsOf(item).join(""),
    );
    return null;
  }
  render(<Probe />);
  return entries;
}

function flatten(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(flatten);
  if (!isValidElement<{ children?: ReactNode }>(node)) return [];
  return node.type === Fragment ? flatten(node.props.children) : [node];
}

const t = (key: string) => i18n.t(key, { ns: "files" });

describe("document row capabilities", () => {
  const editable = documents.data.find((document) => document.id === "doc_lab_1") as FileDto;
  const restricted = documents.data.find((document) => document.id === "doc_lab_4") as FileDto;

  it("keeps every deed, Download first, in the menu", () => {
    const columns = columnsFrom(() =>
      useDocumentColumns({
        pendingKeepId: null,
        showRunLink: true,
        onDownload: () => {},
        onKeep: () => {},
        onDelete: () => {},
      }),
    );
    const html = actionCell(columns, editable);

    expect(html).toContain(`aria-label="Plus d'actions pour ${editable.name}"`);
    expect(menuEntries(columns, editable)).toEqual([
      t("row.download"),
      t("row.openRun"),
      t("row.keep"),
      "—",
      t("row.delete"),
    ]);
  });

  it("does not invent actions for a document whose capabilities deny them", () => {
    const columns = columnsFrom(() =>
      useDocumentColumns({
        pendingKeepId: null,
        onDownload: () => {},
        onKeep: () => {},
        onDelete: () => {},
      }),
    );
    const html = actionCell(columns, restricted);

    expect(html).not.toContain("<button");
  });
});
