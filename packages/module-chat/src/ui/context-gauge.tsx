// SPDX-License-Identifier: Apache-2.0

/**
 * The composer's context gauge: a ring beside the send button, filled toward the size past which
 * the engine summarizes the history, its detail in a popover (which a touch screen opens, unlike a
 * tooltip). Nothing renders until a turn has measured something. After a switch to a model whose
 * sizing the catalog gives, the last measure is read against that model's window and threshold.
 */

import * as React from "react";
import { cn } from "@appstrate/ui/cn";
import {
  formatCompactTokens,
  formatContextWindow,
  formatWindowPercent,
} from "@appstrate/ui/context-window";
import { Button } from "@appstrate/ui/components/button";
import { Popover, PopoverContent, PopoverTrigger } from "@appstrate/ui/components/popover";
import { Progress } from "@appstrate/ui/components/progress";
import { useChatHost } from "./runtime-context.ts";
import { COMPOSER_BUTTON_CLASS } from "./touch-targets.ts";
import type { ContextLevel } from "./turn-context.ts";
import { useConversationContext } from "./use-conversation-context.ts";

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

// With the share beside the ring the button widens: `w-auto` follows `size-*` in the stylesheet.
const SHARE_CLASS = "w-auto min-w-10 gap-1 px-2 desktop-pointer:w-auto desktop-pointer:min-w-8";

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
  const { t, lang, modelLabel } = useChatHost();
  const titleId = React.useId();
  const reading = useConversationContext();
  if (!reading) return null;
  const { context, measuredWith, readAgainstSelected } = reading;

  const counts = t("contextUsage.counts", {
    used: formatCompactTokens(context.tokens, lang),
    max: formatContextWindow(context.window, context.windowAssumed === true, lang),
  });
  const sentence = t(LEVEL_SENTENCE[context.level], {
    threshold: formatCompactTokens(context.compactAt, lang),
  });
  const showShare = context.level !== "ok";

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className={cn(
            COMPOSER_BUTTON_CLASS,
            showShare && SHARE_CLASS,
            LEVEL_TEXT[context.level],
            className,
          )}
          aria-label={t("contextUsage.label", { counts, sentence })}
        >
          <Ring ratio={context.ratio} />
          {/* aria-hidden: the label already says the level. */}
          {showShare ? (
            <span aria-hidden="true" className="text-xs tabular-nums">
              {formatWindowPercent(context.ratio, lang)}
            </span>
          ) : null}
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
        {context.windowAssumed ? (
          <p className="text-muted-foreground">
            {t("contextUsage.windowAssumed", {
              window: formatCompactTokens(context.window, lang),
            })}
          </p>
        ) : null}
        {measuredWith ? (
          <p className="text-muted-foreground">
            {readAgainstSelected && modelLabel
              ? t("contextUsage.measuredWithReadAgainst", {
                  model: measuredWith,
                  selected: modelLabel,
                })
              : t("contextUsage.measuredWith", { model: measuredWith })}
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
