// SPDX-License-Identifier: Apache-2.0

/**
 * The shared table primitive. What a screenshot does not show is pinned here:
 * where the row's link lives, that every column is drawn at every width, and
 * which columns are held in place when the table scrolls.
 */

import { describe, it, expect } from "bun:test";
import { DataTable, type DataColumn } from "../data-table.tsx";
import i18n, { i18nReady } from "../../i18n.ts";
import { render } from "../../test/render.tsx";
import { installFakeStorage } from "../../test/fake-storage.ts";

await i18nReady;
await i18n.changeLanguage("fr");

const storage = installFakeStorage();

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
  { id: "num", header: "#", width: 56, cell: (r) => <span>{r.id}</span> },
  { id: "name", header: "Nom", width: 120, elastic: true, cell: (r) => <span>{r.name}</span> },
  {
    id: "when",
    header: "Date",
    width: 96,
    align: "end",
    cell: (r) => <span>{r.when}</span>,
  },
];

function table(props: Partial<Parameters<typeof DataTable<Row>>[0]> = {}) {
  return render(
    <DataTable
      tableId="test-table"
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

describe("semantics", () => {
  it("is a real table, named for a screen reader", () => {
    const html = table();
    expect(html).toContain("<table");
    expect(html).toContain('aria-label="Essai"');
    expect([...html.matchAll(/<th /g)]).toHaveLength(COLUMNS.length);
  });

  it("keeps the card frame and lets the settings surface remove it", () => {
    const html = table();
    expect(html).toContain("bg-card rounded-lg border");
    expect(html).toContain("data-settings-table-surface=integrated");
  });
});

describe("width", () => {
  it("draws every column at every width, and scrolls under their sum", () => {
    // The width never hides a column: which ones show is the reader's call.
    const html = table();
    for (const column of COLUMNS) {
      const head = (html.match(/<th[^>]*>/g) ?? []).find((h) =>
        h.includes(`data-column="${column.id}"`),
      );
      expect(head).toBeDefined();
      expect(head).not.toMatch(/class="[^"]*\bhidden\b/);
    }
    expect(html).toContain("--dt-floor:272px");
    expect(html).toContain("min-w-(--dt-floor)");
  });
});

describe("the row's link", () => {
  it("sits in the first read column", () => {
    const html = table();
    expect(html).toMatch(/<a[^>]*href="\/rows\/a"[^>]*>\s*<div[^>]*>\s*<span>a<\/span>/);
    expect(html).not.toMatch(/<a[^>]*>\s*<div[^>]*>\s*<span>Alpha<\/span>/);
  });

  it("sits in the column marked as the row's identity, and holds what precedes it", () => {
    const columns = COLUMNS.map((c) => (c.id === "name" ? { ...c, identity: true as const } : c));
    const html = table({ columns });
    expect(html).toMatch(/<a[^>]*href="\/rows\/a"[^>]*>\s*<div[^>]*>\s*<span>Alpha<\/span>/);
    const heads = html.match(/<th[^>]*>/g) ?? [];
    expect(heads.find((head) => head.includes('data-column="num"'))).toContain("sticky");
    expect(heads.find((head) => head.includes('data-column="name"'))).toContain("left:56px");
  });

  it("skips a control before it: a tick is not the row's name", () => {
    const tick: DataColumn<Row> = {
      id: "tick",
      header: "",
      headerNode: <i>x</i>,
      width: 40,
      control: true,
      cell: () => <input type="checkbox" />,
    };
    const html = table({ columns: [tick, ...COLUMNS] });
    expect(html).toMatch(/<a[^>]*href="\/rows\/a"[^>]*>\s*<div[^>]*>\s*<span>a<\/span>/);
  });

  it("carries a name of its own and covers the whole row", () => {
    const html = table();
    expect(html).toContain('aria-label="Ligne Alpha"');
    // The cover lives in a cell that is not held: a `sticky` cell would be its containing block.
    expect(html).toMatch(/<a tabindex="-1" aria-hidden="true" class="absolute inset-0"/);
    // One focusable node per row, not one per cell: the cover is out of the tab order.
    expect([...html.matchAll(/<a (?![^>]*tabindex="-1")/g)]).toHaveLength(ROWS.length);
  });

  it("renders a static row when there is nowhere to go", () => {
    const html = table({ rowHref: () => undefined });
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("cursor-pointer");
    expect(html).toContain("Alpha");
  });
});

describe("states", () => {
  it("offers one full-row button for an in-place detail", () => {
    const html = table({ rowHref: undefined, rowAction: () => {} });
    expect(html).not.toContain("<a ");
    expect([...html.matchAll(/<button /g)]).toHaveLength(ROWS.length);
    expect(html).toContain('aria-label="Ligne Alpha"');
    expect(html).toContain("cursor-pointer");
  });

  it("replaces the head with the empty node — it would label nothing", () => {
    const html = table({ rows: [], empty: <p>Rien ici</p> });
    expect(html).toContain("Rien ici");
    expect(html).not.toContain("<th");
  });

  it("keeps the columns while loading, so the layout does not jump", () => {
    const html = table({ rows: [], isLoading: true });
    expect(html).toContain("<th");
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain("<a ");
  });
});

describe("controls and the row's end", () => {
  const columns: DataColumn<Row>[] = [
    { id: "name", header: "Nom", width: 120, elastic: true, cell: (r) => <span>{r.name}</span> },
    { id: "when", header: "Date", width: 96, cell: (r) => <span>{r.when}</span> },
    {
      id: "role",
      header: "Rôle",
      width: 140,
      elastic: true,
      control: true,
      cell: () => <button type="button">Choisir</button>,
    },
    { id: "actions", header: "", width: 80, align: "end", cell: () => <span>…</span> },
  ];
  const html = table({ columns });

  it("holds the name and the row's end in place", () => {
    const heads = html.match(/<th[^>]*>/g) ?? [];
    expect(heads.filter((head) => head.includes("sticky"))).toHaveLength(2);
    expect(heads.find((head) => head.includes('data-column="name"'))).toContain("sticky");
    expect(heads.find((head) => head.includes('data-column="actions"'))).toContain("sticky");
    expect(heads.find((head) => head.includes('data-column="role"'))).not.toContain("sticky");
  });

  it("lights a held cell with the row", () => {
    const cells = html.match(/<td[^>]*data-column="(?:name|actions)"[^>]*>/g) ?? [];
    expect(cells).toHaveLength(2 * ROWS.length);
    for (const cell of cells) expect(cell).toContain("group-hover/row:bg-(--dt-surface-hover)");
  });
});

describe("a head that is not drawn", () => {
  const columns = COLUMNS.map((c) => (c.id === "when" ? { ...c, hideHeader: true as const } : c));
  const html = table({ columns });

  it("keeps its word for screen readers only", () => {
    expect(html).toMatch(/<th[^>]*data-column="when"[^>]*>\s*<span class="sr-only">Date<\/span>/);
  });

  it("keeps its column and its resize handle", () => {
    expect([...html.matchAll(/<th /g)]).toHaveLength(COLUMNS.length);
    expect(html).toContain('aria-label="Redimensionner la colonne Date"');
  });
});

describe("a column narrower in a narrow table", () => {
  // `num` collapses in a table under 32rem (a compact badge does): its width, the floor and the offset of
  // the held name after it all switch with the table.
  const columns = COLUMNS.map((c) =>
    c.id === "num"
      ? { ...c, narrowWidth: 24 }
      : c.id === "name"
        ? { ...c, identity: true as const }
        : c,
  );
  const html = table({ columns });
  const head = (id: string) =>
    (html.match(/<th[^>]*>/g) ?? []).find((h) => h.includes(`data-column="${id}"`)) ?? "";

  it("switches its width with the table", () => {
    expect(head("num")).toContain("--dt-w:56px;--dt-w-narrow:24px");
    expect(head("num")).toContain("w-(--dt-w-narrow) @lg/table:w-(--dt-w)");
  });

  it("switches the floor and the held name's offset with it", () => {
    expect(html).toContain("--dt-floor:272px;--dt-floor-narrow:240px");
    expect(head("name")).toContain("--dt-left:56px;--dt-left-narrow:24px");
    expect(head("name")).toContain("left-(--dt-left-narrow) @lg/table:left-(--dt-left)");
  });

  it("keeps one plain width where nothing collapses", () => {
    expect(head("when")).toContain("width:96px");
  });

  it("gives way to a width the reader chose, at every size", () => {
    storage.setItem("appstrate-column-widths-chosen", JSON.stringify({ num: 80 }));
    const chosen = table({ columns, tableId: "chosen" });
    expect(chosen).toContain("width:80px");
    expect(chosen).not.toContain("--dt-w-narrow");
  });
});

describe("resizing", () => {
  it("gives every head a named handle", () => {
    const html = table();
    expect([...html.matchAll(/role="separator"/g)]).toHaveLength(COLUMNS.length);
    expect(html).toContain('aria-label="Redimensionner la colonne Nom"');
    expect(html).toContain("cursor-col-resize");
  });

  it("offers none on a fixed control or on the row's end", () => {
    const html = table({
      columns: [
        COLUMNS[1]!,
        {
          id: "tick",
          header: "",
          headerNode: <i>x</i>,
          width: 40,
          control: true,
          cell: () => null,
        },
        { id: "actions", header: "", width: 80, cell: () => <span>…</span> },
      ],
    });
    expect([...html.matchAll(/role="separator"/g)]).toHaveLength(1);
  });

  it("keeps the chosen width when the table's accessible label changes language", () => {
    storage.setItem("appstrate-column-widths-measured", JSON.stringify({ name: 321 }));
    const french = table({ tableId: "measured", label: "Mesuré" });
    const english = table({ tableId: "measured", label: "Measured" });
    expect(french).toContain('aria-label="Mesuré"');
    expect(english).toContain('aria-label="Measured"');
    expect(french).toContain("width:321px");
    expect(english).toContain("width:321px");
  });

  it("isolates tables even when their accessible labels are identical", () => {
    storage.setItem("appstrate-column-widths-first", JSON.stringify({ name: 345 }));
    expect(table({ tableId: "first", label: "Packages" })).toContain("width:345px");
    expect(table({ tableId: "second", label: "Packages" })).not.toContain("width:345px");
  });

  it("never goes under the declared width", () => {
    storage.setItem("appstrate-column-widths-narrow", JSON.stringify({ when: 10 }));
    expect(table({ tableId: "narrow" })).toContain("width:96px");
  });
});
