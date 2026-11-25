// SPDX-License-Identifier: Apache-2.0

/**
 * The model level of the composer's tools panel, on every format. Lists the org's configured models
 * (`GET /api/models`, the same catalog the server resolves against) and surfaces
 * the chosen preset id; the panel forwards it per turn via the `X-Model-Id`
 * header. The list itself is the dashboard's: `ModelPickerList` from
 * `@appstrate/ui`, models grouped by who pays, the unusable ones greyed with
 * their reason. Only a dead model is disabled: one nothing pays for yet stays
 * pickable, the server answering its turn with the "add your key" path. A model the
 * conversation's last measure already outgrows carries a marker (`model-fit.ts`).
 */

import { useMemo } from "react";
import { SlidersHorizontalIcon, TriangleAlertIcon } from "lucide-react";
import { ModelGenerationControls } from "@appstrate/ui/components/model-generation-controls";
import { buildGenerationLabels } from "@appstrate/ui/components/model-generation-labels";
import { ModelPickerList } from "@appstrate/ui/components/model-picker";
import { groupModelsForPicker } from "@appstrate/ui/components/model-picker-groups";
import { buildModelPickerLabels } from "@appstrate/ui/components/model-picker-labels";
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
export type ModelPanelView = "models" | "configuration";

const hasGenerationOverrides = (generation: ModelGenerationSettings) =>
  generation.temperature != null || generation.reasoning_level != null;

/**
 * The list of models, or the selected model's settings: the composer's tools panel shows it at its
 * « Modèle » level, whose heading holds the way back from the settings to the list.
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
}: ModelPickerProps & {
  view: ModelPanelView;
  onViewChange: (view: ModelPanelView) => void;
  /** After a pick from the list. */
  onPicked: () => void;
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
      <div className="desktop-pointer:px-3 flex max-h-[min(20rem,calc(100dvh-8rem))] min-h-0 flex-col px-5 py-2 max-md:max-h-[70dvh]">
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
    // cmdk's items pad 8 px: the list's 12 (4 under a mouse) puts their text with the heading's.
    <div className="desktop-pointer:px-1 flex max-h-[min(20rem,calc(100dvh-8rem))] min-h-0 flex-col overflow-y-auto px-3 py-2 max-md:max-h-none">
      <ModelPickerList
        groups={groups}
        value={selectedId}
        onSelect={(id) => {
          if (id === null) return;
          onSelect(id);
          onPicked();
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
              aria-label={`${t("model.settings")}: ${model.label ?? model.modelId}`}
              title={t("model.settings")}
              data-testid="model-settings"
              onClick={() => {
                onSelect(model.id);
                onViewChange("configuration");
              }}
              className="text-muted-foreground hover:text-foreground desktop-pointer:size-7 relative -my-1 -mr-1 flex size-11 shrink-0 items-center justify-center rounded-md"
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
        // Rows a thumb can hit on touch, dense under a mouse; a phone's sheet has room for more of them.
        listClassName="max-h-[min(15rem,calc(100dvh-10rem))] max-md:max-h-[55dvh] [&_[cmdk-item]]:min-h-11 [&_[cmdk-item]]:items-center desktop-pointer:[&_[cmdk-item]]:min-h-0"
      />
    </div>
  );
}
