// SPDX-License-Identifier: Apache-2.0

/**
 * The shared table primitive.
 *
 * Three of its rules are invisible in a screenshot and easy to undo by
 * accident, so they are pinned here: the ARIA roles a grid-displayed `<table>`
 * loses, the three column templates that must stay in step with the `tier`
 * each column declares, and where the row's link lives.
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
  { id: "num", header: "#", width: "56px", tier: 2, cell: (r) => <span>{r.id}</span> },
  { id: "name", header: "Nom", width: "minmax(120px,1fr)", cell: (r) => <span>{r.name}</span> },
  {
    id: "when",
    header: "Date",
    width: "96px",
    align: "end",
    tier: 3,
    cell: (r) => <span>{r.when}</span>,
  },
];

function table(props: Partial<Parameters<typeof DataTable<Row>>[0]> = {}) {
  return render(
    <DataTable
      label="Essai"
      tableId="essai"
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

describe("surface", () => {
  it("keeps the card frame and lets the settings surface remove it", () => {
    const html = table();
    expect(html).toContain("bg-card rounded-lg border shadow-sm");
    expect(html).toContain("data-settings-table-surface=integrated");
    expect(html).toContain(":border-0");
    expect(html).toContain(":shadow-none");
  });
});

describe("column templates", () => {
  const html = table();

  it("declares one track per tier, each holding exactly the columns it shows", () => {
    // The three templates are read off the rendered custom properties rather
    // than recomputed here: the point is that each one drops exactly the
    // columns above its tier, no more and no less.
    const tier3 = /--dt-cols-3:\s*([^;"]+)/.exec(html)?.[1];
    const tier2 = /--dt-cols-2:\s*([^;"]+)/.exec(html)?.[1];
    const tier1 = /--dt-cols:\s*([^;"]+)/.exec(html)?.[1];
    expect(tier3?.split(" ")).toHaveLength(COLUMNS.length);
    expect(tier2?.split(" ")).toHaveLength(COLUMNS.filter((c) => c.tier !== 3).length);
    expect(tier1?.split(" ")).toHaveLength(COLUMNS.filter((c) => !c.tier).length);
    expect(tier1).toBe("minmax(120px,1fr)");
  });

  it("publishes the complete floor for a settings ScrollArea", () => {
    // Floors: 56 + 120 + 96. Wide spacing: four 16px gaps/paddings.
    expect(html).toContain("--dt-full-floor:336px");
    expect(html).toContain("data-data-table-scroll");
    expect(html).toContain('data-data-table-column="when"');
    expect(html).toContain('data-data-table-tier="3"');
  });

  it("hides a tiered column's CELL as well as its track", () => {
    // A track dropped without its cell shifts every column after it by one.
    // Head cell plus one body cell per row, for each tiered column.
    for (const [tier, query] of [
      [2, "@xl/table"],
      [3, "@4xl/table"],
    ] as const) {
      const cells = [...html.matchAll(new RegExp(`hidden ${query}:(flex|block)`, "g"))];
      const count = COLUMNS.filter((c) => c.tier === tier).length;
      expect(cells).toHaveLength(count * (1 + ROWS.length));
    }
  });

  it("uses no content-dependent track, and no elastic one without a floor", () => {
    // Each row is its own grid container, so an `auto` track is measured per
    // row and the columns stop lining up — the one thing the table is for.
    // And `minmax(0,…)` tells the browser it may take the column away
    // entirely: that is how the agent name, the only thing naming a run,
    // measured 6px at a 900px window before the tiers existed.
    for (const col of COLUMNS) {
      expect(col.width).not.toContain("auto");
      expect(col.width).toMatch(/^(\d+px|minmax\([1-9]\d*px,[\d.]+fr\))$/);
    }
  });
});

describe("the row's link", () => {
  it("sits in the first column of tier one", () => {
    const html = table();
    // `num` waits for a wider table: a link parked there leaves the row
    // unclickable on a phone. It belongs to `name`.
    expect(html).toMatch(/<a[^>]*href="\/rows\/a"[^>]*>\s*<span>Alpha<\/span>\s*<\/a>/);
    expect(html).not.toMatch(/<a[^>]*>\s*<span>a<\/span>/);
  });

  it("carries a name of its own and covers the whole row", () => {
    const html = table();
    expect(html).toContain('aria-label="Ligne Alpha"');
    // The cover belongs to the row, not to the first cell: a held (`sticky`)
    // cell is the containing block of anything absolute inside it, so a link
    // stretched from there would cover that one cell.
    expect(html).toMatch(/<td role="presentation" class="absolute inset-0[^"]*"><a tabindex="-1"/);
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
    expect(html).toContain("absolute inset-0 cursor-pointer");
    expect(html).toContain("hover:bg-muted/50");
    // The row itself shows the hand, so a name raised above the cover does too.
    expect(html).toContain("hover:bg-muted/50 cursor-pointer");
  });

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

describe("controls and the row's end", () => {
  const columns: DataColumn<Row>[] = [
    { id: "name", header: "Nom", width: "minmax(120px,1fr)", cell: (r) => <span>{r.name}</span> },
    { id: "when", header: "Date", width: "96px", tier: 2, cell: (r) => <span>{r.when}</span> },
    {
      id: "role",
      header: "Rôle",
      width: "minmax(140px,1fr)",
      control: true,
      cell: () => <button type="button">Choisir</button>,
    },
    { id: "actions", header: "", width: "80px", align: "end", cell: () => <span>…</span> },
  ];
  const html = table({ columns });

  it("never hides a control: it has no tier class and sits in the narrowest template", () => {
    const tier1 = /--dt-cols:\s*([^;"]+)/.exec(html)?.[1];
    expect(tier1).toBe("minmax(120px,1fr) minmax(140px,1fr) 80px");
    expect(html).not.toMatch(/data-data-table-column="role"[^>]*class="[^"]*hidden/);
    expect(html).not.toMatch(/data-data-table-column="actions"[^>]*class="[^"]*hidden/);
  });

  it("scrolls instead: the narrow table keeps the floor of everything it still shows", () => {
    // Floors 120 + 140 + 80, and four 12px gaps/paddings.
    expect(html).toContain("--dt-floor:388px");
    expect(html).toContain("min-w-(--dt-floor)");
  });

  it("holds the name and the row's end in place", () => {
    const heads = html.match(/<th[^>]*>/g) ?? [];
    expect(heads.filter((head) => head.includes("sticky"))).toHaveLength(2);
    expect(heads.find((head) => head.includes('column="name"'))).toContain("sticky");
    expect(heads.find((head) => head.includes('column="actions"'))).toContain("sticky");
    expect(heads.find((head) => head.includes('column="role"'))).not.toContain("sticky");
  });
});

describe("resizing", () => {
  const html = table();

  it("gives every head a focusable, named handle at its floor", () => {
    expect([...html.matchAll(/role="separator"/g)]).toHaveLength(COLUMNS.length);
    expect(html).toContain('aria-label="Redimensionner la colonne Nom"');
    expect(html).toContain('aria-valuemin="120"');
    expect(html).toContain("cursor-col-resize");
  });

  it("offers none on the row's end, which has no head to name", () => {
    const withEnd = table({
      columns: [
        ...COLUMNS,
        { id: "actions", header: "", width: "80px", cell: () => <span>…</span> },
      ],
    });
    expect([...withEnd.matchAll(/role="separator"/g)]).toHaveLength(COLUMNS.length);
  });
});

describe("remembered widths", () => {
  it("keys them on the table's id, not on its translated label", () => {
    storage.setItem("appstrate-column-widths-widths-essai", JSON.stringify({ name: 321 }));
    const french = table({ tableId: "widths-essai", label: "Essai" });
    const english = table({ tableId: "widths-essai", label: "Trial" });
    expect(french).toContain("321px");
    expect(english).toContain("321px");
  });

  it("keeps two tables that share a label apart", () => {
    storage.setItem("appstrate-column-widths-widths-a", JSON.stringify({ name: 333 }));
    expect(table({ tableId: "widths-a", label: "Liste" })).toContain("333px");
    expect(table({ tableId: "widths-b", label: "Liste" })).not.toContain("333px");
  });
});
