// SPDX-License-Identifier: Apache-2.0

/**
 * The list toolbar, through what it renders without being opened.
 *
 * The menus are Radix and stay unmounted until a pointer opens them, and there
 * is no DOM here — but the menus are the least of it. What the toolbar has to
 * get right is the part that is always visible: which filters read as ON, and
 * the chips, which are the only way to remove ONE filter without going back
 * into the menu that set it.
 */

import { describe, it, expect } from "bun:test";
import { ListToolbar, type FilterSpec } from "../list-toolbar.tsx";
import { render } from "./run-fixture.tsx";

function filters(over: Partial<Record<"status" | "kind", string>> = {}): FilterSpec[] {
  return [
    {
      id: "status",
      label: "Statut",
      value: over.status,
      options: [
        { value: "failed", label: "échoué" },
        { value: "success", label: "succès" },
      ],
      onChange: () => {},
    },
    {
      id: "kind",
      label: "Type",
      value: over.kind,
      options: [{ value: "inline", label: "Inline" }],
      onChange: () => {},
    },
  ];
}

describe("with nothing filtered", () => {
  const html = render(<ListToolbar filters={filters()} />);

  it("shows the dimensions and no chips", () => {
    expect(html).toContain("Statut");
    expect(html).toContain("Type");
    expect(html).not.toContain("Statut :");
    expect(html).not.toContain("Tout effacer");
  });

  it("leaves every trigger neutral", () => {
    expect(html).not.toContain("border-primary");
  });
});

describe("with one filter on", () => {
  const html = render(<ListToolbar filters={filters({ status: "failed" })} />);

  it("says so on the trigger, in the chosen value's own words", () => {
    // Not "1 filtre": the value is what you need to read to know what you are
    // looking at.
    expect(html).toContain("échoué");
    expect(html).toContain("border-primary");
  });

  it("repeats it as a removable chip", () => {
    expect(html).toContain("Statut :");
    expect(html).toContain('aria-label="Retirer le filtre Statut : échoué"');
  });

  it("offers no clear-all for a single filter — the chip already is one", () => {
    expect(html).not.toContain("Tout effacer");
  });
});

describe("with two filters on", () => {
  const html = render(<ListToolbar filters={filters({ status: "failed", kind: "inline" })} />);

  it("chips both and offers to clear them at once", () => {
    expect(html).toContain('aria-label="Retirer le filtre Statut : échoué"');
    expect(html).toContain('aria-label="Retirer le filtre Type : Inline"');
    expect(html).toContain("Tout effacer");
  });
});

describe("actions", () => {
  it("keeps what acts on the whole list at the end of the row", () => {
    const html = render(
      <ListToolbar filters={filters()} actions={<button>Tout marquer comme lu</button>} />,
    );
    expect(html).toContain("Tout marquer comme lu");
    expect(html).toContain("ml-auto");
  });
});
