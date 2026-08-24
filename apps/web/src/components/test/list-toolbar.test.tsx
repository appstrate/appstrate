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
import { ListFooter, ListToolbar, type FilterSpec } from "../list-toolbar.tsx";
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

  it("carries no count, and says the row is shut", () => {
    expect(html).not.toMatch(/>\d</);
    expect(html).toContain('aria-expanded="false"');
  });

  it("wears no surface — it adjusts the view, it does not act on the data", () => {
    // Three tiers on one row, and the surface is what separates them: Filters
    // and Columns are a border on the canvas, the page's own action keeps a
    // white, slightly raised one.
    expect(html).toContain("bg-transparent");
    expect(html).toContain("shadow-none");
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
  it("is not on the bar at all — it belongs under the table", () => {
    // A toolbar is what you act WITH, a footer is what the table came to.
    // shadcn keeps it in the pagination row for the same reason, and it frees
    // the end of the bar that runs out of room first.
    const html = render(<ListToolbar filters={filters()} />);
    expect(html).not.toContain("runs");
  });
});

describe("the footer", () => {
  it("prints the caller's words, and the page controls beside them", () => {
    const html = render(
      <ListFooter count="50 runs">
        <span>Page 1 sur 14</span>
      </ListFooter>,
    );
    expect(html).toContain("50 runs");
    expect(html.indexOf("50 runs")).toBeLessThan(html.indexOf("Page 1 sur 14"));
  });

  it("renders for a count alone — the arrows are the option, not the point", () => {
    expect(render(<ListFooter count="3 runs" />)).toContain("3 runs");
  });

  it("renders nothing when there is nothing to say", () => {
    expect(render(<ListFooter />)).toBe("");
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

  it("keeps search and utilities left, and the representation at the far right", () => {
    const html = render(
      <ListToolbar
        filters={filters()}
        view="table"
        onViewChange={() => {}}
        search={{ value: "", onChange: () => {}, placeholder: "Rechercher…" }}
        actions={<button>Nouvel agent</button>}
      />,
    );
    expect(html.indexOf("Rechercher…")).toBeLessThan(html.indexOf("Nouvel agent"));
    expect(html.indexOf("Nouvel agent")).toBeLessThan(html.indexOf("aria-pressed"));
  });
});

describe("the filters button", () => {
  it("shows the row is open, on the button that opened it", () => {
    const html = render(<ListToolbar filters={filters({ status: ["failed"] })} />);
    expect(html).toContain('aria-expanded="true"');
    // The state IS the style hook: no second flag to keep in step.
    expect(html).toContain("aria-expanded:bg-accent");
  });
});
