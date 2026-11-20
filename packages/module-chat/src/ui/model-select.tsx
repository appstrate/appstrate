// SPDX-License-Identifier: Apache-2.0

/**
 * Model picker shown under the composer input. Lists the org's configured models
 * (`GET /api/models`, the same catalog the server resolves against) and surfaces
 * the chosen preset id; the panel forwards it per turn via the `X-Model-Id`
 * header. The list itself is the dashboard's: `ModelPickerList` from
 * `@appstrate/ui`, models grouped by who pays, the unusable ones greyed with
 * their reason. Only a dead model is disabled: one nothing pays for yet stays
 * pickable, the server answering its turn with the "add your key" path.
 */

import { useMemo, useState, useSyncExternalStore } from "react";
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from "@appstrate/ui/components/sheet";
import { useIsMobile } from "@appstrate/ui/use-mobile";
import type { OrgModelOption } from "./models-data.ts";
import { isModelSelectable } from "@appstrate/core/model-selectable";
import {
  isModelPanelOpen,
  setModelPanelOpen,
  setToolsPanelOpen,
  subscribeModelPanel,
} from "./model-store.ts";
import { useChatHost } from "./runtime-context.ts";
import type { ModelGenerationSettings } from "@appstrate/core/model-generation";

interface Props {
  models: OrgModelOption[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  generation: ModelGenerationSettings;
  onGenerationChange: (value: ModelGenerationSettings) => void;
  /** The catalog is being read: the pill's box is reserved. */
  pending?: boolean;
  /** The catalog could not be read: the pill says so, disabled. */
  failed?: boolean;
}

export function ModelSelect({
  models,
  selectedId,
  onSelect,
  generation,
  onGenerationChange,
  pending = false,
  failed = false,
}: Props) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const isMobile = useIsMobile();
  // A phone's panel is opened from the composer's "+" panel; a desktop's from its button.
  const phoneOpen = useSyncExternalStore(subscribeModelPanel, isModelPanelOpen, isModelPanelOpen);
  const open = isMobile ? phoneOpen : popoverOpen;
  const setOpen = (next: boolean) => {
    (isMobile ? setModelPanelOpen : setPopoverOpen)(next);
    if (!next) setView("models");
  };
  // The list, or one model's settings (reached from its row's icon).
  const [view, setView] = useState<"models" | "configuration">("models");
  const { t, can, personalModelCredentials, modelCredentials } = useChatHost();
  const active = models.find((m) => m.id === selectedId);
  const groups = useMemo(
    () =>
      groupModelsForPicker(models, {
        credentials: modelCredentials,
        personalAllowed: personalModelCredentials,
        canConnect: can("model-provider-credentials:connect"),
      }),
    [models, modelCredentials, personalModelCredentials, can],
  );
  const hasOverrides = generation.temperature != null || generation.reasoning_level != null;
  const hasNoGenerationControls =
    active?.generation?.temperature === "unsupported" &&
    active.generation.reasoning.supported === "unsupported";

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

  const supportsSettings = (model: OrgModelOption) =>
    model.generation?.temperature !== "unsupported" ||
    model.generation?.reasoning.supported !== "unsupported";
  const panel =
    view === "configuration" && active ? (
      <div className="flex max-h-[min(20rem,calc(100dvh-8rem))] min-h-0 flex-col p-2 max-md:max-h-[70dvh]">
        <button
          type="button"
          onClick={() => setView("models")}
          className="text-muted-foreground hover:text-foreground flex min-h-11 w-full shrink-0 items-center gap-1.5 text-left text-sm md:min-h-8"
        >
          <ChevronLeftIcon className="size-4 shrink-0" aria-hidden="true" />
          <span className="truncate font-medium">{active.label ?? active.modelId}</span>
        </button>
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
              labels={buildGenerationLabels(
                (key, options) => t(`settings:${key}`, options),
                active.generation,
              )}
            />
          )}
        </div>
      </div>
    ) : (
      <div className="flex max-h-[min(20rem,calc(100dvh-8rem))] min-h-0 flex-col overflow-y-auto p-2">
        {/* A phone reaches this panel from the "+" panel's model row: this goes back to it. */}
        {isMobile && (
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setToolsPanelOpen(true);
            }}
            className="text-muted-foreground hover:text-foreground flex min-h-11 w-full shrink-0 items-center gap-1.5 text-left text-sm"
          >
            <ChevronLeftIcon className="size-4 shrink-0" aria-hidden="true" />
            <span className="truncate font-medium">{t("composer.tools")}</span>
          </button>
        )}
        <ModelPickerList
          groups={groups}
          value={selectedId}
          onSelect={(id) => {
            if (id === null) return;
            onSelect(id);
            // A phone's pick is the end of the errand: back to the composer, which names it.
            if (isMobile) setOpen(false);
          }}
          selectable={isModelSelectable}
          // `settings:` — the picker's labels live in the settings bundle (a boot
          // namespace, so already loaded); the host binds `t` to `chat`.
          labels={buildModelPickerLabels((key, options) => t(`settings:${key}`, options))}
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
                  setView("configuration");
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
  // A phone has no button on the composer's line: its panel opens from the "+" panel's model row.
  const trigger = (
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
  );
  // A phone shows the picker as a panel from the bottom, rows a thumb can hit; a desktop keeps its popover.
  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>{trigger}</SheetTrigger>
        <SheetContent
          side="bottom"
          showCloseButton={false}
          className="max-h-[85dvh] overflow-hidden rounded-t-2xl p-0 pb-[env(safe-area-inset-bottom)]"
        >
          <SheetTitle className="sr-only">{t("model.settingsTitle")}</SheetTitle>
          <SheetDescription className="sr-only">{t("model.settingsTitle")}</SheetDescription>
          <div aria-hidden className="bg-border mx-auto mt-2 h-1 w-9 rounded-full" />
          {panel}
        </SheetContent>
      </Sheet>
    );
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={6}
        collisionPadding={12}
        aria-label={t("model.settingsTitle")}
        className="w-[min(21rem,calc(100vw-1.5rem))] overflow-hidden p-0 shadow-xl"
      >
        {panel}
      </PopoverContent>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
    </Popover>
  );
}
