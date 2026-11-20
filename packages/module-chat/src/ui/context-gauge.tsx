// SPDX-License-Identifier: Apache-2.0

/**
 * The composer's context gauge: how full the conversation's context is, as the
 * engine measured it on the last turn's final model call (`turn-context.ts`).
 * A ring beside the send button, its detail one tap away — a popover, not a
 * tooltip, so it opens on a touch screen too. Nothing renders until a turn has
 * measured something: an empty ring would claim a zero nobody measured.
 */

import * as React from "react";
import { useAuiState } from "@assistant-ui/react";
import { cn } from "@appstrate/ui/cn";
import { Button } from "@appstrate/ui/components/button";
import { Popover, PopoverContent, PopoverTrigger } from "@appstrate/ui/components/popover";
import { useChatHost } from "./runtime-context.ts";
import { COMPOSER_BUTTON_CLASS } from "./touch-targets.ts";
import { latestConversationContext, type ContextLevel } from "./turn-context.ts";

const LEVEL_CLASS: Record<ContextLevel, string> = {
  ok: "text-muted-foreground",
  near: "text-warning",
  full: "text-destructive",
};

const RING_RADIUS = 6;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function Ring({ ratio }: { ratio: number }) {
  return (
    <svg viewBox="0 0 16 16" className="size-4 -rotate-90" aria-hidden="true">
      <circle cx="8" cy="8" r={RING_RADIUS} fill="none" strokeWidth="2" className="stroke-muted" />
      <circle
        cx="8"
        cy="8"
        r={RING_RADIUS}
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        stroke="currentColor"
        strokeDasharray={RING_CIRCUMFERENCE}
        strokeDashoffset={RING_CIRCUMFERENCE * (1 - ratio)}
      />
    </svg>
  );
}

export function ContextGauge({ className }: { className?: string }) {
  const { t, modelLabel } = useChatHost();
  const messages = useAuiState((s) => s.thread.messages);
  const context = React.useMemo(() => latestConversationContext(messages), [messages]);
  if (!context) return null;

  const summary = t("context.summary", {
    used: context.tokens,
    max: context.window,
    percent: context.ratio,
  });
  const measuredWithOther =
    context.modelLabel !== null && modelLabel != null && context.modelLabel !== modelLabel;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className={cn(COMPOSER_BUTTON_CLASS, LEVEL_CLASS[context.level], className)}
          aria-label={t("context.label", { summary })}
          data-context-level={context.level}
        >
          <Ring ratio={context.ratio} />
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-72 space-y-2 p-3 text-sm">
        <p className="font-medium">{t("context.title")}</p>
        <div className="flex items-center gap-2">
          <div
            className="bg-muted h-1.5 flex-1 overflow-hidden rounded-full"
            role="meter"
            aria-label={t("context.title")}
            aria-valuemin={0}
            aria-valuemax={context.window}
            aria-valuenow={Math.min(context.tokens, context.window)}
            aria-valuetext={summary}
          >
            <div
              className={cn("h-full rounded-full bg-current", LEVEL_CLASS[context.level])}
              style={{ width: `${context.ratio * 100}%` }}
            />
          </div>
        </div>
        <p className="tabular-nums">{summary}</p>
        {context.compactAt !== undefined ? (
          <p className="text-muted-foreground">
            {t(context.level === "full" ? "context.compactNext" : "context.compactAt", {
              threshold: context.compactAt,
            })}
          </p>
        ) : context.level !== "ok" ? (
          <p className="text-muted-foreground">{t("context.noCompaction")}</p>
        ) : null}
        {context.compacted ? (
          <p className="text-muted-foreground">{t("context.compacted")}</p>
        ) : null}
        {measuredWithOther ? (
          <p className="text-muted-foreground">
            {t("context.measuredWith", { model: context.modelLabel ?? "" })}
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
