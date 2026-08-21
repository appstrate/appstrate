// SPDX-License-Identifier: Apache-2.0

/**
 * The list toolbar, through what it renders without being opened.
 *
 * The filter menus are Radix popovers and stay unmounted until a pointer opens
 * them; there is no DOM here to open one with, so the ticking rule is tested
 * through `toggleValue` directly. What IS testable without a pointer is the
 * bar's own shape: which controls it puts on the line, and whether the filter
 * row is showing.
 */

import { describe, it, expect } from "bun:test";
import { ListToolbar, type FilterSpec } from "../list-toolbar.tsx";
import { toggleValue } from "../../lib/toggle-value.ts";
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

describe("ticking a value", () => {
  it("adds it, and unticking removes it", () => {
    expect(toggleValue([], "failed")).toEqual(["failed"]);
    expect(toggleValue(["failed"], "timeout")).toEqual(["failed", "timeout"]);
    expect(toggleValue(["failed", "timeout"], "failed")).toEqual(["timeout"]);
  });

  it("does nothing else — ticking the last box keeps every tick", () => {
    // A version that also collapsed "all ticked" to "nothing ticked" was true
    // of the RESULTS and nonsense as an interaction: Kind has two values, so
    // ticking the second silently unticked the first, and Scope has one, so its
    // only box could never stay ticked at all.
    expect(toggleValue(["package"], "inline")).toEqual(["package", "inline"]);
    expect(toggleValue([], "me")).toEqual(["me"]);
  });
});

describe("with nothing filtered", () => {
  const html = render(<ListToolbar filters={filters()} />);

  it("keeps the filters behind their button, and the row shut", () => {
    expect(html).toContain("Filtres");
    expect(html).not.toContain("Statut");
    expect(html).not.toContain("Type");
  });

  it("invites: the button is dashed and carries no count", () => {
    expect(html).toContain("border-dashed");
    expect(html).toContain('aria-expanded="false"');
  });

  it("offers no reset — there is nothing to reset", () => {
    expect(html).not.toContain("Réinitialiser");
  });
});

describe("with something already filtering", () => {
  const html = render(
    <ListToolbar filters={filters({ status: ["failed", "timeout"], kind: ["inline"] })} />,
  );

  it("opens the row by itself", () => {
    // A list you did not filter yourself — a link someone sent you — has to say
    // why it is short, and a badge saying "3" does not say which three.
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("Statut");
    expect(html).toContain("Type");
  });

  it("counts what is on, on the button", () => {
    expect(html).toContain("Filtres");
    expect(html).toMatch(/>3</);
  });

  it("stops inviting: the button's border closes", () => {
    expect(html).not.toContain("border-dashed");
  });

  it("names the values on each dimension's own trigger", () => {
    expect(html).toContain("échoué");
    expect(html).toContain("timeout");
    expect(html).toContain("Inline");
  });

  it("counts instead of naming past two", () => {
    const many = render(
      <ListToolbar filters={filters({ status: ["failed", "timeout", "success"] })} />,
    );
    expect(many).toContain("3 sélectionnés");
  });
});

describe("the reset", () => {
  it("shows in the filter row once something is on", () => {
    const html = render(
      <ListToolbar filters={filters({ status: ["failed"] })} onReset={() => {}} />,
    );
    expect([...html.matchAll(/Réinitialiser/g)]).toHaveLength(1);
  });

  it("is absent when the caller gave no way to reset in one go", () => {
    // Deliberate: a missing reset is visible and harmless, where a reset that
    // loops over the filters looks right and clears only the last one. These
    // filters are URL parameters, and three `setSearchParams` in one tick all
    // read the same committed location.
    const html = render(<ListToolbar filters={filters({ status: ["failed"] })} />);
    expect(html).not.toContain("Réinitialiser");
  });
});

describe("the search", () => {
  it("stays on the bar, whatever the filters are doing", () => {
    // It used to travel into the disclosure row with the filters, which was
    // simply a bug: it is the one thing you type into, and it does not move.
    const withRowOpen = render(
      <ListToolbar
        filters={filters({ status: ["failed"] })}
        search={{ value: "", onChange: () => {}, placeholder: "Rechercher des runs…" }}
      />,
    );
    const bar = withRowOpen.slice(0, withRowOpen.indexOf("Statut"));
    expect(bar).toContain("Rechercher des runs…");
  });
});

describe("the result count", () => {
  it("prints the caller's words, at the end of the bar", () => {
    // The toolbar counts nothing itself: it serves runs, schedules and
    // packages, and one that formats "3 runs" for all of them would one day
    // say it about agents.
    const html = render(<ListToolbar filters={filters()} count="3 runs" />);
    expect(html).toContain("3 runs");
    expect(html.indexOf("3 runs")).toBeLessThan(html.indexOf("Filtres"));
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
