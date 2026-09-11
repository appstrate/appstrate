// SPDX-License-Identifier: Apache-2.0

/**
 * `SectionCard` is the pane divider ~28 call sites across the run, agent and
 * integration surfaces are built out of, so its header is the ONLY thing that
 * makes those panes reachable by heading navigation. It rendered its title as
 * styled text for as long as it existed; these assertions are what keeps it a
 * heading.
 *
 * Same no-DOM harness as the other component suites, through the shared
 * `test/render.tsx`.
 */

import { describe, it, expect } from "bun:test";
import { render } from "../../test/render.tsx";
import { SectionCard } from "../section-card.tsx";

/** Every class the card painted before the heading existed. */
const OUTER_CLASSES = "border-border bg-card mb-4 overflow-hidden rounded-lg border";
const HEADER_CLASSES =
  "bg-background text-foreground border-border flex items-center justify-between border-b px-4 py-3 text-xs font-semibold tracking-wide uppercase";

describe("SectionCard", () => {
  it("renders the title as a heading that names the whole card", () => {
    const html = render(
      <SectionCard title="Configuration">
        <p>corps</p>
      </SectionCard>,
    );

    // The heading itself, and the group it names. `useId` picks the value, so
    // the assertion is that the two agree — not what the value is.
    const heading = html.match(/<h3 id="([^"]+)">Configuration<\/h3>/);
    expect(heading).not.toBeNull();
    expect(html).toContain(`role="group"`);
    expect(html).toContain(`aria-labelledby="${heading?.[1]}"`);
  });

  it("gives every card on a page a distinct heading id", () => {
    const html = render(
      <>
        <SectionCard title="Exécution">
          <p>a</p>
        </SectionCard>
        <SectionCard title="Fichiers">
          <p>b</p>
        </SectionCard>
      </>,
    );

    const ids = [...html.matchAll(/<h3 id="([^"]+)">/g)].map((m) => m[1]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("paints exactly what it painted before the heading was added", () => {
    // The heading carries no classes of its own: Tailwind's preflight zeroes
    // `h1`-`h6` margins and makes them inherit font-size/weight, so the title
    // inherits the header row's type exactly as the bare text node did. If a
    // class ever lands on the `<h3>`, or moves off either div, this fails.
    const html = render(
      <SectionCard title="Configuration" headerRight={<button>Ajouter</button>}>
        <p>corps</p>
      </SectionCard>,
    );

    expect(html).toContain(`class="${OUTER_CLASSES}"`);
    expect(html).toContain(`class="${HEADER_CLASSES}"`);
    expect(html).toContain(`<h3 id=`);
    expect(html).not.toMatch(/<h3 [^>]*class=/);
    // `headerRight` still follows the title inside the same flex row.
    expect(html).toContain(`</h3><button>Ajouter</button>`);
  });
});
