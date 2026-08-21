// SPDX-License-Identifier: Apache-2.0

/**
 * The list toolbar, through what it renders without being opened.
 *
 * It is a port of shadcn's `DataTableFacetedFilter` + `DataTableToolbar` (the
 * Tasks example), so what is worth pinning is the part that survives a restyle:
 * where the chosen values are shown, when the button starts counting instead of
 * naming, and when the reset appears. The menu itself is a Radix popover and
 * stays unmounted until a pointer opens it — there is no DOM here to open it
 * with, so the ticking rule is tested through `toggleValue` directly.
 */

import { describe, it, expect } from "bun:test";
import { ListToolbar, type FilterSpec } from "../list-toolbar.tsx";
import { toggleValue } from "../../lib/toggle-value.ts";
import { render as renderNode } from "./run-fixture.tsx";

/**
 * The bar as the reader sees it.
 *
 * The toolbar keeps an invisible copy of its left end at the END of its markup,
 * laid out only to be measured — it is what decides whether the filters fold
 * into one button. Everything before it is the real bar, so the suite cuts
 * there rather than counting every control twice.
 */
function render(node: Parameters<typeof renderNode>[0]): string {
  const html = renderNode(node);
  const ghost = html.indexOf("data-measure");
  return ghost === -1 ? html : html.slice(0, ghost);
}

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

  it("shows one button per dimension, and no reset", () => {
    expect(html).toContain("Statut");
    expect(html).toContain("Type");
    expect(html).not.toContain("Réinitialiser");
  });

  it("invites: dashed, with a plus", () => {
    expect([...html.matchAll(/border-dashed/g)]).toHaveLength(2);
    expect([...html.matchAll(/lucide-circle-plus/g)]).toHaveLength(2);
  });
});

describe("a dimension that is filtering", () => {
  const html = render(<ListToolbar filters={filters({ status: ["failed"] })} />);

  it("stops inviting: the border closes and the plus goes with it", () => {
    // Dashed AND `+` mean "an empty slot you can fill". Once it is filled the
    // button is a statement, not an invitation — and dropping both saves the
    // width exactly where width is scarce, since a filter with values is the
    // wide one. Kind is still empty here, so exactly one of each remains.
    expect([...html.matchAll(/border-dashed/g)]).toHaveLength(1);
    expect([...html.matchAll(/lucide-circle-plus/g)]).toHaveLength(1);
  });
});

describe("the chosen values", () => {
  it("live inside the dimension's own button", () => {
    // One place, not a second row repeating it — which is what two earlier
    // versions of this toolbar did, in two different ways.
    const html = render(<ListToolbar filters={filters({ status: ["failed"] })} />);
    const button = html.slice(html.indexOf("Statut"), html.indexOf("Type"));
    expect(button).toContain("échoué");
  });

  it("are named while there are few of them", () => {
    const html = render(<ListToolbar filters={filters({ status: ["failed", "timeout"] })} />);
    expect(html).toContain("échoué");
    expect(html).toContain("timeout");
    expect(html).not.toContain("sélectionnés");
  });

  it("give way to a count once there are more", () => {
    const html = render(
      <ListToolbar filters={filters({ status: ["failed", "timeout", "success"] })} />,
    );
    expect(html).toContain("3 sélectionnés");
  });
});

describe("the reset", () => {
  it("appears as soon as anything is filtered, once for the whole row", () => {
    const html = render(
      <ListToolbar
        filters={filters({ status: ["failed"], kind: ["inline"] })}
        onReset={() => {}}
      />,
    );
    expect([...html.matchAll(/Réinitialiser/g)]).toHaveLength(1);
  });

  it("is absent when the caller gave no way to reset in one go", () => {
    // Deliberate: a missing reset is visible and harmless, where a reset that
    // loops over the filters looks right and clears only the last one. These
    // filters are URL parameters, and three `setSearchParams` in one tick all
    // read the same committed location — the button cleared the status and
    // left the scope and the kind exactly where they were.
    const html = render(<ListToolbar filters={filters({ status: ["failed"] })} />);
    expect(html).not.toContain("Réinitialiser");
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
