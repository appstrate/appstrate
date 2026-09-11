// SPDX-License-Identifier: Apache-2.0

import { useId } from "react";

interface SectionCardProps {
  title: string;
  /** Extra content rendered inline in the header (e.g. an upload button). */
  headerRight?: React.ReactNode;
  children: React.ReactNode;
}

/**
 * The pane divider every run/agent/integration surface is built out of.
 *
 * The title is a real `<h3>`, not styled text. ~28 call sites across the run,
 * agent and integration surfaces are stacks of these cards, and a title that is
 * only styled text leaves every one of those panes invisible to a reader
 * navigating by heading. `<h3>` because the page title `PageHeader` renders is
 * an `<h2>` — one level down, no skipped level.
 *
 * The heading carries NO classes on purpose. Tailwind's preflight zeroes every
 * margin and makes `h1`–`h6` inherit `font-size` and `font-weight`, and
 * `text-transform`/`letter-spacing` inherit natively, so the heading picks up
 * the header row's `text-xs font-semibold tracking-wide uppercase` exactly as
 * the bare text node did. Adding the element changes the accessibility tree
 * and nothing that is painted.
 *
 * `role="group"` + `aria-labelledby` names the card as a whole rather than only
 * the header row — a group, not a `region` landmark: ~28 cards promoted to
 * landmarks would bury the page's real ones.
 */
export function SectionCard({ title, headerRight, children }: SectionCardProps) {
  const titleId = useId();
  return (
    <div
      role="group"
      aria-labelledby={titleId}
      className="border-border bg-card mb-4 overflow-hidden rounded-lg border"
    >
      <div className="bg-background text-foreground border-border flex items-center justify-between border-b px-4 py-3 text-xs font-semibold tracking-wide uppercase">
        <h3 id={titleId}>{title}</h3>
        {headerRight}
      </div>
      <div className="space-y-3 p-4">{children}</div>
    </div>
  );
}
