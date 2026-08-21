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

  it("leaves every trigger unmarked", () => {
    // State, not styling: `data-filtered` is what says a dimension is on, so
    // the assertion survives a restyle and fails on a behaviour change.
    expect(html).not.toContain("data-filtered");
  });
});

describe("with one filter on", () => {
  const html = render(<ListToolbar filters={filters({ status: "failed" })} />);

  it("says so on the trigger, in the chosen value's own words", () => {
    // Not "1 filtre": the value is what you need to read to know what you are
    // looking at. The reference puts a count badge there, which only tells you
    // something when a dimension takes several values at once; these take one.
    expect(html).toContain("échoué");
    expect(html).toContain("data-filtered");
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

describe("the result count", () => {
  it("prints the caller's words, after the last filter", () => {
    // The toolbar counts nothing itself: it serves runs, schedules and
    // packages, and one that formats "3 runs" for all of them would one day
    // say it about agents.
    const html = render(<ListToolbar filters={filters({ status: "failed" })} count="3 runs" />);
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
