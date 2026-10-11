// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { isValidElement, type ComponentProps, type ReactNode } from "react";
import type { DataColumn } from "../data-table.tsx";
import { TableRowActions } from "../table-row-actions.tsx";
import { useDocumentColumns } from "../document-columns.tsx";
import type { FileDto } from "../../hooks/use-files.ts";
import { documents } from "../../lab/fixtures.ts";
import { render } from "./run-fixture.tsx";

function columnsFrom<T>(useColumns: () => DataColumn<T>[]): DataColumn<T>[] {
  let captured: DataColumn<T>[] = [];
  function Probe() {
    captured = useColumns();
    return null;
  }
  render(<Probe />);
  return captured;
}

function rowActions(node: ReactNode): ComponentProps<typeof TableRowActions> {
  if (
    !isValidElement<ComponentProps<typeof TableRowActions>>(node) ||
    node.type !== TableRowActions
  )
    throw new Error("Expected TableRowActions");
  return node.props;
}

function actionCell<T>(columns: DataColumn<T>[], row: T) {
  const actions = columns.find((column) => column.id === "actions");
  if (!actions) throw new Error("Missing Actions column");
  return rowActions(actions.cell(row));
}

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
    const actions = actionCell(columns, editable);

    expect(actions.menuLabel).toContain(editable.name);
    expect(actions.children).toBeTruthy();
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
    const actions = actionCell(columns, restricted);

    expect(actions.menuLabel).toBeUndefined();
    expect(actions.children).toBeUndefined();
  });
});
