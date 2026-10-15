// SPDX-License-Identifier: Apache-2.0

/**
 * The shared table primitive. What a screenshot does not show is pinned here:
 * where the row's link lives, which columns a tier hides and which are held in
 * place when the table scrolls.
 */

import { describe, it, expect } from "bun:test";
import { DataTable, type DataColumn } from "../data-table.tsx";
import i18n, { i18nReady } from "../../i18n.ts";
import { render } from "../../test/render.tsx";

await i18nReady;
await i18n.changeLanguage("fr");

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
  { id: "num", header: "#", width: 56, tier: 2, cell: (r) => <span>{r.id}</span> },
  { id: "name", header: "Nom", width: 120, elastic: true, cell: (r) => <span>{r.name}</span> },
  {
    id: "when",
    header: "Date",
    width: 96,
    align: "end",
    tier: 3,
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

describe("tiers", () => {
  it("draws every column, and scrolls, unless the table is tiered", () => {
    const html = table();
    expect(html).not.toContain("hidden @xl/table");
    expect(html).toContain("--dt-floor-3:272px");
  });

  it("hides a tiered column's head AND its cells", () => {
    const html = table({ tiered: true });
    for (const [tier, query] of [
      [2, "@xl/table"],
      [3, "@4xl/table"],
    ] as const) {
      const hidden = [...html.matchAll(new RegExp(`hidden ${query}:table-cell`, "g"))];
      const count = COLUMNS.filter((c) => c.tier === tier).length;
      expect(hidden).toHaveLength(count * (1 + ROWS.length));
    }
  });

  it("publishes the floor of each tier", () => {
    const html = table({ tiered: true });
    expect(html).toContain("--dt-floor:120px");
    expect(html).toContain("--dt-floor-2:176px");
    expect(html).toContain("--dt-floor-3:272px");
  });
});

describe("the row's link", () => {
  it("sits in the first column of tier one", () => {
    const html = table();
    // `num` waits for a wider table: a link parked there leaves the row
    // unclickable on a phone. It belongs to `name`.
    expect(html).toMatch(/<a[^>]*href="\/rows\/a"[^>]*>\s*<div[^>]*>\s*<span>Alpha<\/span>/);
    expect(html).not.toMatch(/<a[^>]*>\s*<div[^>]*>\s*<span>a<\/span>/);
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
    { id: "when", header: "Date", width: 96, tier: 2, cell: (r) => <span>{r.when}</span> },
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
  const html = table({ columns, tiered: true });

  it("never hides a control: it has no tier class and counts in the narrowest floor", () => {
    expect(html).toContain("--dt-floor:340px");
    expect(html).not.toMatch(/<t[hd][^>]*data-column="role"[^>]*class="[^"]*hidden/);
    expect(html).not.toMatch(/<t[hd][^>]*data-column="actions"[^>]*class="[^"]*hidden/);
  });

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
