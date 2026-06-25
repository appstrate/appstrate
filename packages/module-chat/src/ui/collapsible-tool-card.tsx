// SPDX-License-Identifier: Apache-2.0

/**
 * Shared collapsible card shell for tool calls — a `bg-card` bordered
 * container with a header button (spinner while running / check icon + label +
 * chevron toggling open state) and a body revealed when open. Used by both the
 * single-call fallback and the coalesced tool group; only the header label and
 * body content vary.
 */

import * as React from "react";
import { CheckIcon, ChevronDownIcon, ChevronUpIcon, Loader2Icon } from "lucide-react";

export function CollapsibleToolCard({
  running,
  header,
  children,
  className,
}: React.PropsWithChildren<{
  running: boolean;
  header: React.ReactNode;
  className?: string;
}>) {
  const [open, setOpen] = React.useState(false);
  return (
    <div
      className={`bg-card text-card-foreground my-3 w-full rounded-lg border ${className ?? ""}`}
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
        onClick={() => setOpen((v) => !v)}
      >
        {running ? (
          <Loader2Icon className="text-muted-foreground size-4 shrink-0 animate-spin" />
        ) : (
          <CheckIcon className="text-primary size-4 shrink-0" />
        )}
        <span className="flex-1 truncate">{header}</span>
        {open ? (
          <ChevronUpIcon className="text-muted-foreground size-4" />
        ) : (
          <ChevronDownIcon className="text-muted-foreground size-4" />
        )}
      </button>
      {open && children}
    </div>
  );
}
