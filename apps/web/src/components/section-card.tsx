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
 * The title is a real `<h3>` (one level under `PageHeader`'s `<h2>`) so panes are
 * reachable by heading. It carries NO classes on purpose: preflight resets margins
 * and the header row's text styles inherit. `role="group"`, not a `region` landmark:
 * dozens of landmarks would bury the page's real ones.
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
