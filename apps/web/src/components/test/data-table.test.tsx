// SPDX-License-Identifier: Apache-2.0

/**
 * The shared table primitive.
 *
 * Three of its rules are invisible in a screenshot and easy to undo by
 * accident, so they are pinned here: the ARIA roles a grid-displayed `<table>`
 * loses, the two column templates that must stay in step with the `secondary`
 * flags, and where the row's link lives.
 */

import { describe, it, expect } from "bun:test";
import { DataTable, type DataColumn } from "../data-table.tsx";
import { render } from "./run-fixture.tsx";

interface Row {
  id: string;
  name: string;
  when: string;
}

const ROWS: Row[] = [
  { id: "a", name: "Alpha", when: "hier" },
  { id: "b", name: "Beta", when: "aujourd'hui" },
];

const COLUMNS: DataColumn<Row>[] = [
  { id: "num", header: "#", width: "56px", secondary: true, cell: (r) => <span>{r.id}</span> },
  { id: "name", header: "Nom", width: "minmax(0,1fr)", cell: (r) => <span>{r.name}</span> },
  {
    id: "when",
    header: "Date",
    width: "96px",
    align: "end",
    secondary: true,
    cell: (r) => <span>{r.when}</span>,
  },
];

function table(props: Partial<Parameters<typeof DataTable<Row>>[0]> = {}) {
  return render(
    <DataTable
      label="Essai"
      columns={COLUMNS}
      rows={ROWS}
      rowKey={(r) => r.id}
      rowHref={(r) => `/rows/${r.id}`}
      rowLabel={(r) => `Ligne ${r.name}`}
      {...props}
    />,
  );
}

describe("roles", () => {
  const html = table();

  it("re-declares every table role", () => {
    // Overriding `display` on table elements drops their implicit roles in
    // Chrome and Firefox, so the grid layout would otherwise cost the table
    // its semantics entirely.
    expect(html).toContain('role="table"');
    expect(html).toContain('role="rowgroup"');
    expect(html).toContain('role="columnheader"');
    expect(html).toContain('role="cell"');
    // One head row plus one per data row.
    expect([...html.matchAll(/role="row"/g)]).toHaveLength(1 + ROWS.length);
  });

  it("names the table for a screen reader", () => {
    expect(html).toContain('aria-label="Essai"');
  });
});

describe("column templates", () => {
  const html = table();

  it("declares one track per column, and one per surviving column below md", () => {
    // Both templates are read off the rendered custom properties rather than
    // recomputed here: the point is that the narrow one drops exactly the
    // `secondary` tracks, no more and no less.
    const wide = /--dt-cols-md:\s*([^;"]+)/.exec(html)?.[1];
    const narrow = /--dt-cols:\s*([^;"]+)/.exec(html)?.[1];
    expect(wide?.split(" ")).toHaveLength(COLUMNS.length);
    expect(narrow?.split(" ")).toHaveLength(COLUMNS.filter((c) => !c.secondary).length);
    expect(narrow).toBe("minmax(0,1fr)");
  });

  it("hides the secondary CELLS as well as their tracks", () => {
    // A track dropped without its cell shifts every column after it by one.
    const secondaryCells = [...html.matchAll(/hidden md:(flex|block)/g)];
    const secondaryCount = COLUMNS.filter((c) => c.secondary).length;
    // Head cells plus body cells.
    expect(secondaryCells).toHaveLength(secondaryCount * (1 + ROWS.length));
  });

  it("uses no content-dependent track", () => {
    // Each row is its own grid container, so an `auto` track is measured per
    // row and the columns stop lining up — the one thing the table is for.
    for (const col of COLUMNS) {
      expect(col.width).not.toContain("auto");
      expect(col.width).toMatch(/^(\d+px|minmax\(0,[\d.]+fr\)|[\d.]+fr)$/);
    }
  });
});

describe("the row's link", () => {
  it("sits in the first column that survives the narrow breakpoint", () => {
    const html = table();
    // `num` is secondary: a link parked there leaves the row unclickable on a
    // phone. It belongs to `name`.
    expect(html).toMatch(/<a[^>]*href="\/rows\/a"[^>]*>\s*<span>Alpha<\/span>\s*<\/a>/);
    expect(html).not.toMatch(/<a[^>]*>\s*<span>a<\/span>/);
  });

  it("carries a name of its own and covers the whole row", () => {
    const html = table();
    expect(html).toContain('aria-label="Ligne Alpha"');
    expect(html).toContain("after:absolute after:inset-0");
    // One focusable node per row, not one per cell.
    expect([...html.matchAll(/<a /g)]).toHaveLength(ROWS.length);
  });

  it("renders a static row when there is nowhere to go", () => {
    const html = table({ rowHref: () => undefined });
    expect(html).not.toContain("<a ");
    expect(html).toContain("Alpha");
  });
});

describe("states", () => {
  it("replaces the head with the empty node — it would label nothing", () => {
    const html = table({ rows: [], empty: <p>Rien ici</p> });
    expect(html).toContain("Rien ici");
    expect(html).not.toContain('role="columnheader"');
  });

  it("keeps the columns while loading, so the layout does not jump", () => {
    const html = table({ rows: [], isLoading: true });
    expect(html).toContain('role="columnheader"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain("<a ");
  });
});
