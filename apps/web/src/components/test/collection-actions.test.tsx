// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { isValidElement, type ComponentProps, type ReactNode } from "react";
import type { DataColumn } from "../data-table.tsx";
import { TableRowActions } from "../table-row-actions.tsx";
import { useDocumentColumns } from "../document-columns.tsx";
import type { FileDto } from "../../hooks/use-files.ts";
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

const editable: FileDto = {
  object: "file",
  id: "file_editable",
  uri: "appfile://file_editable",
  purpose: "agent_output",
  spaceId: "spc_test",
  runId: "run_test",
  chat_session_id: null,
  packageId: "@acme/report",
  name: "summary.xlsx",
  mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  size: 184_320,
  downloadable: true,
  capabilities: {
    visible: true,
    metadata: true,
    download: true,
    preview: false,
    keep: true,
    delete: true,
  },
  previewable: false,
  preview_kind: null,
  expiresAt: "2026-01-02T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
};

// Visible but not readable: the metadata capability is off, so the name and
// mime degrade the way the API degrades them.
const restricted: FileDto = {
  object: "file",
  id: "file_restricted",
  uri: "appfile://file_restricted",
  purpose: "user_upload",
  spaceId: "spc_test",
  runId: "run_test",
  chat_session_id: null,
  packageId: null,
  name: "document",
  mime: "application/octet-stream",
  size: 71_680,
  downloadable: false,
  capabilities: {
    visible: true,
    metadata: false,
    download: false,
    preview: false,
    keep: false,
    delete: false,
  },
  previewable: false,
  preview_kind: null,
  expiresAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("document row capabilities", () => {
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
