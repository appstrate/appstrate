// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import type { DataColumn } from "../../components/data-table.tsx";
import { columnMenu, identityColumnIndex, visibleColumns } from "../column-visibility.ts";

type Row = { id: string };
const cell = () => null;
const columns: DataColumn<Row>[] = [
  { id: "select", header: "", width: 40, control: true, cell },
  { id: "name", header: "Nom", width: 120, elastic: true, cell },
  { id: "status", header: "Statut", width: 96, cell },
  { id: "role", header: "Rôle", width: 120, control: true, cell },
  { id: "actions", header: "", width: 80, align: "end", cell },
];
const ids = (list: DataColumn<Row>[]) => list.map((column) => column.id);

describe("identityColumnIndex", () => {
  it("is the first read column: a tick or select before it is not the row's name", () => {
    expect(identityColumnIndex(columns)).toBe(1);
  });

  it("is the column marked as the identity, wherever it sits", () => {
    const marked: DataColumn<Row>[] = [
      ...columns.slice(0, 2),
      { id: "status", header: "Statut", width: 96, identity: true, cell },
      ...columns.slice(3),
    ];
    expect(identityColumnIndex(marked)).toBe(2);
  });
});

describe("columnMenu", () => {
  it("offers every named column, the row's name as the one that cannot be hidden", () => {
    const toggle = () => {};
    const menu = columnMenu(columns, { hidden: ["status"], toggle });
    expect(menu.options).toEqual([
      { id: "name", label: "Nom", required: true },
      { id: "status", label: "Statut", required: false },
      { id: "role", label: "Rôle", required: false },
    ]);
    expect(menu.hidden).toEqual(["status"]);
    expect(menu.onToggle).toBe(toggle);
  });
});

describe("visibleColumns", () => {
  it("takes out what the reader hid, and nothing else", () => {
    expect(ids(visibleColumns(columns, ["status", "role"]))).toEqual(["select", "name", "actions"]);
  });

  it("keeps the row's name and the headerless columns whatever is stored", () => {
    // A stored list may name a column the menu never offered (a stale or hand-edited value).
    expect(ids(visibleColumns(columns, ["name", "actions", "select"]))).toEqual(ids(columns));
  });
});
