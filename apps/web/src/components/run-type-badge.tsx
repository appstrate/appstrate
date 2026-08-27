// SPDX-License-Identifier: Apache-2.0

/**
 * What KIND of run this is — one launched inline from the chat, or a run of a
 * catalogued agent. The two read identically everywhere else on the page (same
 * title shape, same status, same tabs) while being different things: an inline
 * run has no catalog entry, no version, and cannot be re-run from its own page.
 *
 * Drawn as a neutral outlined chip with an icon, deliberately NOT as a coloured
 * badge: the status badge beside it is the coloured one, and two competing
 * colours in the same line is how a reader stops seeing either. The icon
 * carries the distinction at a glance, the word carries it unambiguously, and
 * the `title` explains it for whoever stops on it.
 */

import { useTranslation } from "react-i18next";
import { Bot, MessageSquare } from "lucide-react";
import { cn } from "@appstrate/ui/cn";
import type { EnrichedRun } from "@appstrate/shared-types";

export function RunTypeBadge({
  run,
  className,
}: {
  run: Pick<EnrichedRun, "package_ephemeral">;
  className?: string;
}) {
  const { t } = useTranslation(["agents"]);
  const isInline = run.package_ephemeral;
  const Icon = isInline ? MessageSquare : Bot;

  return (
    <span
      className={cn(
        "border-border text-muted-foreground inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase",
        className,
      )}
      title={isInline ? t("runs.inlineBadgeTitle") : t("runs.agentBadgeTitle")}
    >
      <Icon size={10} className="shrink-0" aria-hidden />
      {isInline ? t("runs.inlineBadge") : t("runs.agentBadge")}
    </span>
  );
}
