// SPDX-License-Identifier: Apache-2.0

/**
 * The composer's context gauge: a ring beside the send button, filled toward the size past which
 * the engine summarizes the history, its detail in a popover (which a touch screen opens, unlike a
 * tooltip). Nothing renders until a turn has measured something.
 */

import * as React from "react";
import { useAuiState } from "@assistant-ui/react";
import { cn } from "@appstrate/ui/cn";
import { formatCompactTokens } from "@appstrate/ui/context-window";
import { Button } from "@appstrate/ui/components/button";
import { Popover, PopoverContent, PopoverTrigger } from "@appstrate/ui/components/popover";
import { Progress } from "@appstrate/ui/components/progress";
import { useChatHost } from "./runtime-context.ts";
import { COMPOSER_BUTTON_CLASS } from "./touch-targets.ts";
import { latestConversationContext, type ContextLevel } from "./turn-context.ts";

const LEVEL_TEXT: Record<ContextLevel, string> = {
  ok: "text-muted-foreground",
  near: "text-warning",
  full: "text-destructive",
};
const LEVEL_FILL: Record<ContextLevel, string> = {
  ok: "bg-muted-foreground",
  near: "bg-warning",
  full: "bg-destructive",
};
const LEVEL_SENTENCE: Record<ContextLevel, string> = {
  ok: "contextUsage.compactAt",
  near: "contextUsage.compactNear",
  full: "contextUsage.compactNext",
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
  const { t, modelId } = useChatHost();
  const titleId = React.useId();
  const messages = useAuiState((s) => s.thread.messages);
  const context = React.useMemo(() => latestConversationContext(messages), [messages]);
  if (!context) return null;

  const counts = t("contextUsage.counts", {
    used: formatCompactTokens(context.tokens),
    max: formatCompactTokens(context.window),
  });
  const sentence = t(LEVEL_SENTENCE[context.level], {
    threshold: formatCompactTokens(context.compactAt),
  });
  const measuredWith =
    context.modelId !== null && modelId != null && context.modelId !== modelId
      ? context.modelLabel
      : null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className={cn(COMPOSER_BUTTON_CLASS, LEVEL_TEXT[context.level], className)}
          aria-label={t("contextUsage.label", { counts, sentence })}
        >
          <Ring ratio={context.ratio} />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        aria-labelledby={titleId}
        className="w-72 space-y-2 p-3 text-sm"
      >
        <p id={titleId} className="font-medium">
          {t("contextUsage.title")}
        </p>
        <Progress
          aria-hidden
          value={Math.min(context.tokens, context.compactAt)}
          max={context.compactAt}
          className="h-1.5"
          indicatorClassName={LEVEL_FILL[context.level]}
        />
        <p className="tabular-nums">{counts}</p>
        <p className="text-muted-foreground">{sentence}</p>
        {measuredWith ? (
          <p className="text-muted-foreground">
            {t("contextUsage.measuredWith", { model: measuredWith })}
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
