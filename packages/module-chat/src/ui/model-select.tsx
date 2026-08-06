// SPDX-License-Identifier: Apache-2.0

/**
 * Model/provider picker shown under the composer input — ported from the
 * appstrate-chat satellite (ModelSelect.tsx + models.ts helper). Lists the
 * org's configured models (`GET /api/models`, the same catalog the server
 * resolves against) and surfaces the chosen preset id; the panel forwards
 * it per turn via the `X-Model-Id` header.
 */

import { useState } from "react";
import { CheckIcon, ChevronDownIcon, SlidersHorizontalIcon } from "lucide-react";
import { cn } from "@appstrate/ui/cn";
import { ModelGenerationControls } from "@appstrate/ui/components/model-generation-controls";
import { Popover, PopoverContent, PopoverTrigger } from "@appstrate/ui/components/popover";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@appstrate/ui/components/tabs";
import type { OrgModelOption } from "./models-data.ts";
import { isModelLive } from "../model-liveness.ts";
import { useChatHost } from "./runtime-context.ts";
import {
  mapModelReasoningLevels,
  type ModelGenerationSettings,
} from "@appstrate/core/model-generation";

/** Group/button label for a managed model — provider-neutral, binding not exposed. */
const MANAGED_LABEL = "Géré";

function providerLabel(model: { providerName?: string | null; aliased?: boolean }): string {
  // Managed models don't expose their binding — group/badge them neutrally (their
  // `providerName` is nulled server-side anyway).
  if (model.aliased) return MANAGED_LABEL;
  // `providerName` is the server's registry-resolved display name (`providerId`
  // → `displayName`) — the single source for provider labels. We deliberately do
  // NOT fall back to `apiShape`: it's ambiguous (OpenCode Go and OpenAI both use
  // `openai-completions`), which is the bug this replaced.
  return model.providerName || MANAGED_LABEL;
}

interface Props {
  models: OrgModelOption[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  generation: ModelGenerationSettings;
  onGenerationChange: (value: ModelGenerationSettings) => void;
}

interface ProviderGroup {
  provider: string;
  models: OrgModelOption[];
}

/** Stable, deterministic grouping by provider label (insertion order). */
function groupByProvider(models: OrgModelOption[]): ProviderGroup[] {
  const groups = new Map<string, OrgModelOption[]>();
  for (const m of models) {
    const provider = providerLabel(m);
    const bucket = groups.get(provider);
    if (bucket) bucket.push(m);
    else groups.set(provider, [m]);
  }
  return [...groups.entries()].map(([provider, list]) => ({ provider, models: list }));
}

export function ModelSelect({
  models,
  selectedId,
  onSelect,
  generation,
  onGenerationChange,
}: Props) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"models" | "configuration">("models");
  const { t } = useChatHost();
  const active = models.find((m) => m.id === selectedId);
  const groups = groupByProvider(models);
  const hasOverrides = generation.temperature != null || generation.reasoningLevel != null;
  const hasNoGenerationControls =
    active?.generation?.temperature === "unsupported" &&
    active.generation.reasoning.supported === "unsupported";

  if (models.length === 0) return null;

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
          className="flex max-h-[min(18rem,calc(100dvh-8rem))] min-h-0 flex-col p-2"
        >
          {/* Segmented control, not a nav bar: two equal grid columns spanning the
              popover width. Flex-based overflow measurement is meaningless here. */}
          <TabsList collapse={false} className="grid h-8 w-full shrink-0 grid-cols-2">
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
            {groups.map((group, i) => (
              <div key={group.provider} className={i > 0 ? "mt-1 border-t pt-1" : undefined}>
                <div className="text-muted-foreground px-2 py-1 text-[0.65rem] font-semibold tracking-wider uppercase">
                  {group.provider}
                </div>
                {group.models.map((m) => {
                  const isSelected = m.id === selectedId;
                  // Listed but unusable: its credential can no longer serve
                  // inference. Shown (so the model doesn't just vanish, and the
                  // user learns what to fix) but not pickable — the server's
                  // `pickModel` refuses it anyway.
                  const dead = !isModelLive(m);
                  return (
                    <button
                      key={m.id}
                      type="button"
                      disabled={dead}
                      onClick={() => onSelect(m.id)}
                      className={cn(
                        "flex w-full items-center justify-start gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                        dead
                          ? "text-muted-foreground cursor-not-allowed"
                          : isSelected
                            ? "bg-accent text-accent-foreground"
                            : "hover:bg-accent hover:text-accent-foreground",
                      )}
                    >
                      <CheckIcon
                        className={cn(
                          "size-3.5 shrink-0",
                          isSelected ? "opacity-100" : "opacity-0",
                        )}
                      />
                      <span className="flex-1 truncate text-left">{m.label ?? m.modelId}</span>
                      {dead && (
                        <span className="text-destructive shrink-0 text-[0.65rem] whitespace-nowrap">
                          {t("model.needsReconnection")}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
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
                    labels={{
                      temperature: t("generation.temperature"),
                      temperatureHint: t("generation.temperatureHint"),
                      reasoning: t("generation.reasoning"),
                      reasoningHint: t("generation.reasoningHint"),
                      inherit: t("generation.inherit"),
                      inheritShort: t("generation.inheritShort"),
                      unsupported: t("generation.unsupported"),
                      unsupportedShort: t("generation.unsupportedShort"),
                      levels: mapModelReasoningLevels((level) => t(`generation.level.${level}`)),
                      shortLevels: mapModelReasoningLevels((level) =>
                        t(`generation.levelShort.${level}`),
                      ),
                    }}
                  />
                )}
              </>
            )}
          </TabsContent>
        </Tabs>
      </PopoverContent>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "border-input bg-background hover:bg-accent text-foreground inline-flex max-w-64 items-center justify-start gap-1.5 rounded-md border px-2.5 py-1 text-left text-xs",
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
        </button>
      </PopoverTrigger>
    </Popover>
  );
}
