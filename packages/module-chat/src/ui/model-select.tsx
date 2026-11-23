// SPDX-License-Identifier: Apache-2.0

/**
 * Model picker shown under the composer input. Lists the org's configured models
 * (`GET /api/models`, the same catalog the server resolves against) and surfaces
 * the chosen preset id; the panel forwards it per turn via the `X-Model-Id`
 * header. The list itself is the dashboard's: `ModelPickerList` from
 * `@appstrate/ui`, models grouped by who pays, the unusable ones greyed with
 * their reason. Only a dead model is disabled: one nothing pays for yet stays
 * pickable, the server answering its turn with the "add your key" path. A model the
 * conversation's last measure already outgrows carries a marker (`model-fit.ts`).
 */

import { useMemo, useState } from "react";
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  SlidersHorizontalIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { cn } from "@appstrate/ui/cn";
import { Button } from "@appstrate/ui/components/button";
import { ModelGenerationControls } from "@appstrate/ui/components/model-generation-controls";
import { buildGenerationLabels } from "@appstrate/ui/components/model-generation-labels";
import { ModelPickerList } from "@appstrate/ui/components/model-picker";
import { groupModelsForPicker } from "@appstrate/ui/components/model-picker-groups";
import { buildModelPickerLabels } from "@appstrate/ui/components/model-picker-labels";
import { Popover, PopoverContent, PopoverTrigger } from "@appstrate/ui/components/popover";
import type { OrgModelOption } from "./models-data.ts";
import { selectedModel, type ModelPickerProps } from "./model-picker.ts";
import { isModelSelectable } from "@appstrate/core/model-selectable";
import { useChatHost } from "./runtime-context.ts";
import { modelFit, modelSizing, type ModelFit } from "./model-fit.ts";
import { useConversationContext } from "./use-conversation-context.ts";
import type { ModelGenerationSettings } from "@appstrate/core/model-generation";

const FIT_KEY: Record<ModelFit, string> = {
  window: "model.fit.window",
  threshold: "model.fit.threshold",
};

/** Under the name, as the picker's reason line: legible on touch, no tooltip needed. */
function FitNote({ fit }: { fit: ModelFit }) {
  const { t } = useChatHost();
  return (
    <div className="text-muted-foreground flex items-start gap-1 text-xs">
      <TriangleAlertIcon aria-hidden className="text-warning mt-px size-3 shrink-0" />
      <span>{t(FIT_KEY[fit])}</span>
    </div>
  );
}

/** The list, or one model's settings (reached from its row's icon). */
type ModelPanelView = "models" | "configuration";

const hasGenerationOverrides = (generation: ModelGenerationSettings) =>
  generation.temperature != null || generation.reasoning_level != null;

/**
 * The list of models, or the selected model's settings: the desktop's popover and the phone's
 * "+" panel both show it. `back` draws the settings' own way back to the list, named after the
 * model; the phone's panel has a header of its own that does it.
 */
export function ModelPanel({
  models,
  selectedId,
  onSelect,
  generation,
  onGenerationChange,
  view,
  onViewChange,
  onPicked,
  back = true,
}: ModelPickerProps & {
  view: ModelPanelView;
  onViewChange: (view: ModelPanelView) => void;
  /** After a pick from the list (the phone closes its panel). */
  onPicked?: () => void;
  back?: boolean;
}) {
  const { t, can, personalModelCredentials, modelCredentials } = useChatHost();
  const translateSettings = (key: string, values?: Record<string, string>) =>
    t(`settings:${key}`, values);
  const active = selectedModel(models, selectedId);
  const generationLabels = buildGenerationLabels(translateSettings, active?.generation);
  const groups = useMemo(
    () =>
      groupModelsForPicker(models, {
        credentials: modelCredentials,
        personalAllowed: personalModelCredentials,
        canConnect: can("model-provider-credentials:connect"),
      }),
    [models, modelCredentials, personalModelCredentials, can],
  );
  const reading = useConversationContext();
  const tokens = reading?.context.tokens;
  const measuredModelId = reading?.context.modelId;
  const fits = useMemo(
    () =>
      tokens === undefined
        ? null
        : new Map(
            models.map((model) => [
              model.id,
              modelFit(tokens, modelSizing(model), model.id !== measuredModelId),
            ]),
          ),
    [models, tokens, measuredModelId],
  );
  const hasOverrides = hasGenerationOverrides(generation);
  const hasNoGenerationControls =
    active?.generation?.temperature === "unsupported" &&
    active.generation.reasoning.supported === "unsupported";
  const supportsSettings = (model: OrgModelOption) =>
    model.generation?.temperature !== "unsupported" ||
    model.generation?.reasoning.supported !== "unsupported";

  if (view === "configuration" && active) {
    return (
      <div className="flex max-h-[min(20rem,calc(100dvh-8rem))] min-h-0 flex-col p-2 max-md:max-h-[70dvh]">
        {back && (
          <button
            type="button"
            onClick={() => onViewChange("models")}
            className="text-muted-foreground hover:text-foreground flex min-h-11 w-full shrink-0 items-center gap-1.5 text-left text-sm md:min-h-8"
          >
            <ChevronLeftIcon className="size-4 shrink-0" aria-hidden="true" />
            <span className="truncate font-medium">{active.label ?? active.modelId}</span>
          </button>
        )}
        <div className="min-h-0 overflow-y-auto px-0.5 py-1">
          {hasNoGenerationControls ? (
            <p className="text-muted-foreground rounded-md border border-dashed px-3 py-4 text-center text-xs">
              {t("generation.noneSupported")}
            </p>
          ) : (
            <ModelGenerationControls
              value={generation}
              capabilities={active.generation}
              onChange={onGenerationChange}
              // `settings:` — the shared label family lives in the
              // settings bundle (a boot namespace, so already loaded);
              // the host binds `t` to `chat`.
              labels={generationLabels}
            />
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="flex max-h-[min(20rem,calc(100dvh-8rem))] min-h-0 flex-col overflow-y-auto p-2 max-md:max-h-none">
      <ModelPickerList
        groups={groups}
        value={selectedId}
        onSelect={(id) => {
          if (id === null) return;
          onSelect(id);
          onPicked?.();
        }}
        selectable={isModelSelectable}
        // `settings:` — the picker's labels live in the settings bundle (a boot
        // namespace, so already loaded); the host binds `t` to `chat`.
        renderNote={(model) => {
          const fit = fits?.get(model.id);
          return fit ? <FitNote fit={fit} /> : null;
        }}
        labels={buildModelPickerLabels(translateSettings)}
        // The module imports no router: the host's own page, a full navigation.
        fixLink={(label) => (
          <a href="/preferences/models" className="underline underline-offset-2">
            {label}
          </a>
        )}
        // One icon per model that has settings: it picks the model and opens them.
        rowAction={(row) => {
          const model = models.find((m) => m.id === row.id);
          if (!model || !isModelSelectable(row) || !supportsSettings(model)) return null;
          return (
            <button
              type="button"
              aria-label={`${t("model.tabs.configuration")}: ${model.label ?? model.modelId}`}
              title={t("model.tabs.configuration")}
              data-testid="model-settings"
              onClick={(event) => {
                event.stopPropagation();
                onSelect(model.id);
                onViewChange("configuration");
              }}
              className="text-muted-foreground hover:text-foreground relative -my-1 -mr-1 flex size-9 shrink-0 items-center justify-center rounded-md md:size-7"
            >
              <SlidersHorizontalIcon className="size-4" aria-hidden="true" />
              {hasOverrides && model.id === selectedId && (
                <span
                  aria-hidden="true"
                  className="bg-primary ring-popover absolute top-1.5 right-1.5 size-1.5 rounded-full ring-2"
                />
              )}
            </button>
          );
        }}
        // A phone's panel has room, and rows a thumb can hit.
        listClassName="max-h-[min(15rem,calc(100dvh-10rem))] max-md:max-h-[55dvh] max-md:[&_[cmdk-item]]:min-h-11 max-md:[&_[cmdk-item]]:items-center"
      />
    </div>
  );
}

/**
 * The pill from `md` up, and its popover. A phone has no pill on the composer's line: its list is
 * in the "+" panel (`ModelPanel`, through `ModelPickerProvider`).
 */
export function ModelSelect(props: ModelPickerProps) {
  const { models, selectedId, generation, pending = false, failed = false } = props;
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<ModelPanelView>("models");
  const { t } = useChatHost();
  const active = selectedModel(models, selectedId);
  const hasOverrides = hasGenerationOverrides(generation);

  if (models.length === 0) {
    // The pill itself, emptied: its box (py-1 on a text-sm line, the two 14px icons) is
    // the loaded one's; only the model's name, unknown yet, may make it wider or narrower.
    if (pending)
      return (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled
          aria-hidden
          tabIndex={-1}
          className="bg-muted desktop-pointer:min-h-0 h-auto min-h-10 max-w-[min(16rem,100%)] animate-pulse justify-start gap-1.5 border-transparent px-2.5 py-1 font-normal text-transparent shadow-none disabled:opacity-100 max-md:hidden [&_svg]:size-3.5"
        >
          <SlidersHorizontalIcon className="size-3.5 shrink-0" />
          <span className="font-medium">{t("model.select")}</span>
          <ChevronDownIcon className="size-3.5 shrink-0" />
        </Button>
      );
    if (failed) {
      return (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled
          className="desktop-pointer:min-h-0 h-auto min-h-10 max-w-[min(16rem,100%)] justify-start gap-1.5 px-2.5 py-1 text-left font-normal shadow-none max-md:hidden [&_svg]:size-3.5"
          title={t("model.loadFailed")}
        >
          <TriangleAlertIcon className="text-destructive shrink-0" />
          <span className="truncate font-medium">{t("model.loadFailed")}</span>
        </Button>
      );
    }
    return null;
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setView("models");
      }}
    >
      <PopoverContent
        side="top"
        align="start"
        sideOffset={6}
        collisionPadding={12}
        aria-label={t("model.settingsTitle")}
        className="w-[min(21rem,calc(100vw-1.5rem))] overflow-hidden p-0 shadow-xl"
      >
        <ModelPanel {...props} view={view} onViewChange={setView} />
      </PopoverContent>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn(
            "text-foreground hover:text-foreground desktop-pointer:min-h-0 h-auto min-h-10 gap-1.5 px-2.5 py-1 font-normal shadow-none max-md:hidden [&_svg]:size-3.5",
            "max-w-[min(16rem,100%)] justify-start text-left",
            hasOverrides && "border-primary/40 bg-primary/5",
          )}
          title={t("model.settingsTitle")}
        >
          <SlidersHorizontalIcon className="text-muted-foreground size-3.5 shrink-0" />
          {active ? (
            <span className="truncate font-medium">{active.label ?? active.modelId}</span>
          ) : (
            <span className="font-medium">{t("model.select")}</span>
          )}
          {hasOverrides && <span className="bg-primary size-1.5 rounded-full" aria-hidden="true" />}
          <ChevronDownIcon className="text-muted-foreground size-3.5 shrink-0" />
        </Button>
      </PopoverTrigger>
    </Popover>
  );
}
