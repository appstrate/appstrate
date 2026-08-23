// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { isValidElement, type ComponentProps, type ReactNode } from "react";
import type { DataColumn } from "../data-table.tsx";
import { TableRowActions } from "../table-row-actions.tsx";
import { useDocumentColumns } from "../document-columns.tsx";
import type { DocumentDto } from "../../hooks/use-documents.ts";
import type { IntegrationSummaryWire } from "../../hooks/use-integrations.ts";
import { documents, integrations } from "../../lab/fixtures.ts";
import { useIntegrationListColumns } from "../../pages/integration-list-columns.tsx";
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
  const editable = documents.data.find((document) => document.id === "doc_lab_1") as DocumentDto;
  const restricted = documents.data.find((document) => document.id === "doc_lab_4") as DocumentDto;

  it("keeps Download direct and secondary deeds in the menu", () => {
    let downloaded = "";
    const columns = columnsFrom(() =>
      useDocumentColumns({
        pendingKeepId: null,
        showRunLink: true,
        onDownload: (document) => {
          downloaded = document.id;
        },
        onKeep: () => {},
        onDelete: () => {},
      }),
    );
    const actions = actionCell(columns, editable);

    expect(actions.primary?.label).toBe("Télécharger");
    expect(actions.menuLabel).toContain(editable.name);
    expect(actions.children).toBeTruthy();
    actions.primary?.onSelect();
    expect(downloaded).toBe(editable.id);
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

    expect(actions.primary).toBeUndefined();
    expect(actions.menuLabel).toBeUndefined();
    expect(actions.children).toBeUndefined();
  });
});

describe("integration row action", () => {
  it("keeps its one real deed direct and adds no empty menu", () => {
    let opened = "";
    const columns = columnsFrom(() =>
      useIntegrationListColumns({
        onOpen: (integration) => {
          opened = integration.id;
        },
      }),
    );
    const integration = integrations.data[0] as IntegrationSummaryWire;
    const actions = actionCell(columns, integration);

    expect(actions.primary).toBeTruthy();
    expect(actions.menuLabel).toBeUndefined();
    expect(actions.children).toBeUndefined();
    actions.primary?.onSelect();
    expect(opened).toBe(integration.id);
  });
});
