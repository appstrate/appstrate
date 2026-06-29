// SPDX-License-Identifier: Apache-2.0

/**
 * Shared collapsible card shell for tool calls — a `bg-card` bordered
 * container with a header button (phase icon + label + optional right-aligned
 * meta + chevron) and a body revealed when open. Used by the per-tool rich
 * cards, the coalesced tool group, and the generic fallback; only the header
 * content and body vary.
 *
 * The header icon and border reflect the call `phase` (pending / running /
 * success / error) so a failure is never shown as a green success. Errors
 * auto-expand once so the message is visible without a click.
 */

import * as React from "react";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ClockIcon,
  Loader2Icon,
  XCircleIcon,
} from "lucide-react";
import type { ToolPhase } from "./tool-result.ts";

function PhaseIcon({ phase }: { phase: ToolPhase }) {
  switch (phase) {
    case "running":
      return <Loader2Icon className="text-muted-foreground size-4 shrink-0 animate-spin" />;
    case "error":
      return <XCircleIcon className="text-destructive size-4 shrink-0" />;
    case "pending":
      return <ClockIcon className="text-muted-foreground size-4 shrink-0" />;
    case "success":
    default:
      return <CheckIcon className="text-primary size-4 shrink-0" />;
  }
}

export function CollapsibleToolCard({
  phase,
  header,
  children,
}: React.PropsWithChildren<{
  phase: ToolPhase;
  header: React.ReactNode;
}>) {
  const [open, setOpen] = React.useState(phase === "error");

  // Auto-reveal the body once when a run transitions into an error so the
  // failing call surfaces without a click; a ref keeps it from re-opening after
  // the user manually closes it.
  const autoOpened = React.useRef(open);
  React.useEffect(() => {
    if (phase === "error" && !autoOpened.current) {
      autoOpened.current = true;
      setOpen(true);
    }
  }, [phase]);

  const border = phase === "error" ? "border-destructive/40" : "";
  return (
    <div className={`bg-card text-card-foreground my-3 w-full rounded-lg border ${border}`}>
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
        onClick={() => setOpen((v) => !v)}
      >
        <PhaseIcon phase={phase} />
        <span className="flex-1 truncate">{header}</span>
        {open ? (
          <ChevronUpIcon className="text-muted-foreground size-4 shrink-0" />
        ) : (
          <ChevronDownIcon className="text-muted-foreground size-4 shrink-0" />
        )}
      </button>
      {open && children}
    </div>
  );
}
