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

function filters(over: Partial<Record<"status" | "kind", string[]>> = {}): FilterSpec[] {
  return [
    {
      id: "status",
      label: "Statut",
      values: over.status ?? [],
      options: [
        { value: "failed", label: "échoué" },
        { value: "success", label: "succès" },
        { value: "timeout", label: "timeout" },
      ],
      onChange: () => {},
    },
    {
      id: "kind",
      label: "Type",
      values: over.kind ?? [],
      options: [
        { value: "inline", label: "Inline" },
        { value: "package", label: "Agents" },
      ],
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
});

describe("the trigger", () => {
  it("says what the dimension is, never what is chosen in it", () => {
    // The chips are one line below and say exactly that; a trigger that
    // repeated them was the same words twice, on a button that changed width
    // every time you filtered.
    const html = render(<ListToolbar filters={filters({ status: ["failed"] })} />);
    const triggerRow = html.slice(0, html.indexOf("Statut :"));
    expect(triggerRow).not.toContain("échoué");
  });
});

describe("chips", () => {
  it("gives each chosen VALUE its own, removable on its own", () => {
    // What a trigger cannot express, and the reason the chips are not a
    // duplicate: two statuses, two chips, and you can drop one of them.
    const html = render(<ListToolbar filters={filters({ status: ["failed", "timeout"] })} />);
    expect(html).toContain('aria-label="Retirer le filtre Statut : échoué"');
    expect(html).toContain('aria-label="Retirer le filtre Statut : timeout"');
  });

  it("offers no clear-all for a single chip — the chip already is one", () => {
    const html = render(<ListToolbar filters={filters({ status: ["failed"] })} />);
    expect(html).not.toContain("Tout effacer");
  });

  it("offers one once there are several, across dimensions", () => {
    const html = render(
      <ListToolbar filters={filters({ status: ["failed"], kind: ["inline"] })} />,
    );
    expect(html).toContain('aria-label="Retirer le filtre Statut : échoué"');
    expect(html).toContain('aria-label="Retirer le filtre Type : Inline"');
    expect(html).toContain("Tout effacer");
  });
});

describe("the result count", () => {
  it("prints the caller's words, after the last filter", () => {
    // The toolbar counts nothing itself: it serves runs, schedules and
    // packages, and one that formats "3 runs" for all of them would one day
    // say it about agents.
    const html = render(<ListToolbar filters={filters({ status: ["failed"] })} count="3 runs" />);
    expect(html).toContain("3 runs");
    // At the END of the row: it describes what the filters before it produced.
    expect(html.indexOf("3 runs")).toBeGreaterThan(html.lastIndexOf("Type"));
  });

  it("says nothing when the caller has nothing to say", () => {
    expect(render(<ListToolbar filters={filters()} />)).not.toContain("runs");
  });
});

describe("the view toggle", () => {
  it("appears only for a list that is drawn both ways", () => {
    expect(render(<ListToolbar filters={filters()} />)).not.toContain("aria-pressed");
  });

  it("marks the view in use", () => {
    const html = render(<ListToolbar filters={filters()} view="table" onViewChange={() => {}} />);
    expect(html).toContain('aria-label="Vue tableau" aria-pressed="true"');
    expect(html).toContain('aria-label="Vue cartes" aria-pressed="false"');
  });
});
