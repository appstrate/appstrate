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

import { useMemo, useState } from "react";
import { ChevronDownIcon, SlidersHorizontalIcon, TriangleAlertIcon } from "lucide-react";
import { cn } from "@appstrate/ui/cn";
import { Button } from "@appstrate/ui/components/button";
import { ModelGenerationControls } from "@appstrate/ui/components/model-generation-controls";
import { buildGenerationLabels } from "@appstrate/ui/components/model-generation-labels";
import { ModelPickerList } from "@appstrate/ui/components/model-picker";
import { groupModelsForPicker } from "@appstrate/ui/components/model-picker-groups";
import { buildModelPickerLabels } from "@appstrate/ui/components/model-picker-labels";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { Popover, PopoverContent, PopoverTrigger } from "@appstrate/ui/components/popover";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@appstrate/ui/components/tabs";
import type { OrgModelOption } from "./models-data.ts";
import { isModelSelectable } from "@appstrate/core/model-selectable";
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
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"models" | "configuration">("models");
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
    if (pending) return <Skeleton className="h-7 w-32 rounded-md" aria-hidden />;
    if (failed) {
      return (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled
          className="h-auto max-w-64 justify-start gap-1.5 px-2.5 py-1 text-left font-normal shadow-none [&_svg]:size-3.5"
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
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={6}
        collisionPadding={12}
        aria-label={t("model.settingsTitle")}
        className="w-[min(21rem,calc(100vw-1.5rem))] overflow-hidden p-0 shadow-xl"
      >
        <Tabs
          value={tab}
          onValueChange={(value) => setTab(value as "models" | "configuration")}
          // Tall enough for the reasoning levels on their two rows (the popover
          // is narrower than their one-row width) without an inner scroll.
          className="flex max-h-[min(20rem,calc(100dvh-8rem))] min-h-0 flex-col p-2"
        >
          <TabsList className="grid h-8 w-full shrink-0 grid-cols-2">
            <TabsTrigger value="models" className="h-6 px-2 text-xs">
              {t("model.tabs.models")}
            </TabsTrigger>
            <TabsTrigger
              value="configuration"
              disabled={!active}
              className="relative h-6 px-2 text-xs"
            >
              {t("model.tabs.configuration")}
              {hasOverrides && (
                <span className="bg-primary ml-1.5 size-1.5 rounded-full" aria-hidden="true" />
              )}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="models" className="mt-1 min-h-0 overflow-y-auto p-0">
            <ModelPickerList
              groups={groups}
              value={selectedId}
              onSelect={(id) => id !== null && onSelect(id)}
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
              listClassName="max-h-[min(15rem,calc(100dvh-10rem))]"
            />
          </TabsContent>

          <TabsContent value="configuration" className="mt-1 min-h-0 overflow-y-auto px-0.5 py-1">
            {active && (
              <>
                <div className="text-muted-foreground mb-2 truncate text-xs">
                  {active.label ?? active.modelId}
                </div>
                {hasNoGenerationControls ? (
                  <p className="text-muted-foreground rounded-md border border-dashed px-3 py-4 text-center text-xs">
                    {t("generation.noneSupported")}
                  </p>
                ) : (
                  <ModelGenerationControls
                    stacked
                    compact
                    hideUnsupported
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
              </>
            )}
          </TabsContent>
        </Tabs>
      </PopoverContent>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn(
            "text-foreground hover:text-foreground h-auto gap-1.5 px-2.5 py-1 font-normal shadow-none [&_svg]:size-3.5",
            "max-w-64 justify-start text-left",
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
