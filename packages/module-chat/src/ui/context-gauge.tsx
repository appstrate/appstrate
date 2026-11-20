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
  formatTokenFigure,
  formatWindowPercent,
} from "@appstrate/ui/context-window";
import { Button } from "@appstrate/ui/components/button";
import { Popover, PopoverContent, PopoverTrigger } from "@appstrate/ui/components/popover";
import { Progress } from "@appstrate/ui/components/progress";
import { useChatHost } from "./runtime-context.ts";
import { COMPOSER_BUTTON_CLASS } from "./touch-targets.ts";
import { thresholdShare, type ContextLevel } from "./turn-context.ts";
import { modelFit } from "./model-fit.ts";
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

// With the share beside the ring the button widens: a height and a minimum width, no `size-*`.
const SHARE_CLASS =
  "h-10 min-w-10 shrink-0 gap-1 rounded-lg px-2 desktop-pointer:h-8 desktop-pointer:min-w-8";

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

  // Read against another model, the measure is the measuring model's tokenizer: approximate.
  const counts = t("contextUsage.counts", {
    used: formatTokenFigure(context.tokens, readAgainstSelected, lang),
    max: formatTokenFigure(context.window, context.windowAssumed, lang),
  });
  // Past a declared window, no summary saves the turn: say so, as the model picker does.
  const sentence =
    modelFit(context.tokens, context) === "window"
      ? t("model.fit.window")
      : t(LEVEL_SENTENCE[context.level], {
          threshold: formatCompactTokens(context.compactAt, lang),
        });
  const showShare = context.level !== "ok";

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size={showShare ? "sm" : "icon"}
          variant="ghost"
          className={cn(
            showShare ? SHARE_CLASS : COMPOSER_BUTTON_CLASS,
            LEVEL_TEXT[context.level],
            className,
          )}
          aria-label={t("contextUsage.label", { counts, sentence })}
        >
          <Ring ratio={context.ratio} />
          {/* aria-hidden: the label already says the level. */}
          {showShare ? (
            <span aria-hidden="true" className="text-xs tabular-nums">
              {formatWindowPercent(thresholdShare(context), lang)}
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
        <p className="whitespace-nowrap tabular-nums">{counts}</p>
        <p className="text-muted-foreground">{sentence}</p>
        {context.summarized ? (
          <p className="text-muted-foreground">{t("contextUsage.summarized")}</p>
        ) : null}
        {context.windowAssumed ? (
          <p className="text-muted-foreground">
            {/* Read against the measuring model, "this model" would be the selected one: name it. */}
            {measuredWith && !readAgainstSelected
              ? t("contextUsage.windowAssumedOf", {
                  model: measuredWith,
                  window: formatCompactTokens(context.window, lang),
                })
              : t("contextUsage.windowAssumed", {
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
