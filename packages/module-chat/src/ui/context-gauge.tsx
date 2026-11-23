// SPDX-License-Identifier: Apache-2.0

/**
 * The composer's context gauge: the size past which the engine summarizes the history, and how
 * much of it the conversation takes. Its detail sits in the panel's « Modèle » level; a ring beside
 * send says when the threshold is near. Nothing renders until a turn has measured something. After
 * a switch to a model whose sizing the catalog gives, the last measure is read against that
 * model's window and threshold.
 */

import { cn } from "@appstrate/ui/cn";
import {
  formatCompactTokens,
  formatTokenFigure,
  formatWindowPercent,
} from "@appstrate/ui/context-window";
import { Button } from "@appstrate/ui/components/button";
import { Progress } from "@appstrate/ui/components/progress";
import { useChatHost } from "./runtime-context.ts";
import { useComposerPanel } from "./composer-panel.ts";
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

/** The last measure's figures and sentences, as the gauge reads them; `null` before any. */
function useContextFigures() {
  const { t, lang } = useChatHost();
  const reading = useConversationContext();
  if (!reading) return null;
  const { context, readAgainstSelected } = reading;
  // Read against another model, the measure is the measuring model's tokenizer: approximate.
  const counts = t("contextUsage.counts", {
    used: formatTokenFigure(context.tokens, readAgainstSelected, lang),
    max: formatTokenFigure(context.window, context.windowAssumed, lang),
  });
  const fit = modelFit(context.tokens, context, readAgainstSelected);
  const sentence =
    fit === "window"
      ? t("model.fit.window")
      : t(LEVEL_SENTENCE[context.level === "full" && !fit ? "ok" : context.level], {
          threshold: formatCompactTokens(context.compactAt, lang),
        });
  return { reading, counts, sentence };
}

/**
 * The context's detail, in the panel's « Modèle » level on every format: the model is what the
 * window belongs to. Nothing before a turn has measured something.
 */
export function ContextDetail() {
  const { t, lang, modelLabel } = useChatHost();
  const figures = useContextFigures();
  if (!figures) return null;
  const { reading, counts, sentence } = figures;
  const { context, measuredWith, readAgainstSelected } = reading;
  return (
    <section
      aria-label={t("contextUsage.title")}
      data-testid="context-detail"
      className="desktop-pointer:px-3 desktop-pointer:text-xs space-y-1.5 border-t px-5 pt-3 pb-2 text-sm"
    >
      <p className="font-medium">{t("contextUsage.title")}</p>
      <Progress
        aria-hidden
        value={Math.min(context.tokens, context.compactAt)}
        max={context.compactAt}
        className="h-1.5"
        indicatorClassName={LEVEL_FILL[context.level]}
      />
      <p className="tabular-nums">{counts}</p>
      <p className={LEVEL_TEXT[context.level]}>{sentence}</p>
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
    </section>
  );
}

/**
 * The ring beside send, on every format, once the threshold is near or the draft would cross it:
 * below that the detail waits in the « Modèle » level. A click opens the panel there.
 */
export function ContextIndicator({ draftCrosses }: { draftCrosses: boolean }) {
  const { t, lang } = useChatHost();
  const panel = useComposerPanel();
  const figures = useContextFigures();
  if (!figures) return null;
  const { reading, counts, sentence } = figures;
  const { context } = reading;
  if (context.level === "ok" && !draftCrosses) return null;
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className={cn(
        SHARE_CLASS,
        context.level === "ok" ? "text-warning" : LEVEL_TEXT[context.level],
      )}
      aria-label={t("contextUsage.label", { counts, sentence })}
      aria-haspopup="dialog"
      data-testid="context-indicator"
      onClick={() => panel.openAt("models")}
    >
      <Ring ratio={context.ratio} />
      {/* aria-hidden: the label already says the level. */}
      <span aria-hidden="true" className="text-xs tabular-nums">
        {formatWindowPercent(thresholdShare(context), lang)}
      </span>
    </Button>
  );
}
