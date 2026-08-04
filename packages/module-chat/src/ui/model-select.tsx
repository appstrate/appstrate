// SPDX-License-Identifier: Apache-2.0

/**
 * Model/provider picker shown under the composer input — ported from the
 * appstrate-chat satellite (ModelSelect.tsx + models.ts helper). Lists the
 * org's configured models (`GET /api/models`, the same catalog the server
 * resolves against) and surfaces the chosen preset id; the panel forwards
 * it per turn via the `X-Model-Id` header.
 */

import { useEffect, useRef, useState } from "react";
import { CheckIcon, ChevronDownIcon, SlidersHorizontalIcon } from "lucide-react";
import type { OrgModelOption } from "./models-data.ts";
import { isModelLive } from "../model-liveness.ts";
import { useChatHost } from "./runtime-context.ts";
import type {
  ModelGenerationSettings,
  ModelReasoningLevel,
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

export function ModelSelect({ models, selectedId, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { t } = useChatHost();

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (models.length === 0) return null;
  const active = models.find((m) => m.id === selectedId);
  const groups = groupByProvider(models);

  return (
    <div className="relative" ref={ref}>
      {open && (
        <div className="bg-popover text-popover-foreground absolute bottom-[calc(100%+0.4rem)] left-0 z-10 max-h-80 w-64 overflow-y-auto rounded-lg border p-1 shadow-xl">
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
                    onClick={() => {
                      onSelect(m.id);
                      setOpen(false);
                    }}
                    className={`flex w-full items-center justify-start gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
                      dead
                        ? "text-muted-foreground cursor-not-allowed"
                        : isSelected
                          ? "bg-accent text-accent-foreground"
                          : "hover:bg-accent hover:text-accent-foreground"
                    }`}
                  >
                    <CheckIcon
                      className={`size-3.5 shrink-0 ${isSelected ? "opacity-100" : "opacity-0"}`}
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
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="border-input bg-background hover:bg-accent text-foreground inline-flex max-w-56 items-center justify-start gap-1.5 rounded-md border px-2.5 py-1 text-left text-xs"
        title="Modèle"
      >
        {active ? (
          <span className="truncate font-medium">{active.label ?? active.modelId}</span>
        ) : (
          <span className="font-medium">Modèle</span>
        )}
        <ChevronDownIcon className="text-muted-foreground size-3.5 shrink-0" />
      </button>
    </div>
  );
}

const CHAT_REASONING_LEVELS: ModelReasoningLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

export function GenerationSelect({
  model,
  value,
  onChange,
}: {
  model?: OrgModelOption;
  value: ModelGenerationSettings;
  onChange: (value: ModelGenerationSettings) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { t } = useChatHost();
  const capabilities = model?.generation;

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      {open && (
        <div className="bg-popover text-popover-foreground absolute bottom-[calc(100%+0.4rem)] left-0 z-10 w-72 space-y-3 rounded-lg border p-3 shadow-xl">
          <label className="block space-y-1 text-xs">
            <span className="font-medium">{t("generation.temperature")}</span>
            <input
              className="border-input bg-background w-full rounded-md border px-2 py-1.5"
              type="number"
              min={0}
              max={1}
              step={0.1}
              value={value.temperature ?? ""}
              placeholder={t("generation.inherit")}
              disabled={capabilities?.temperature === "unsupported"}
              onChange={(event) => {
                const { temperature: _temperature, ...rest } = value;
                void _temperature;
                onChange(
                  event.target.value === ""
                    ? rest
                    : { ...rest, temperature: Number(event.target.value) },
                );
              }}
            />
          </label>
          <label className="block space-y-1 text-xs">
            <span className="font-medium">{t("generation.reasoning")}</span>
            <select
              className="border-input bg-background w-full rounded-md border px-2 py-1.5"
              value={value.reasoningLevel ?? ""}
              disabled={capabilities?.reasoning.supported === "unsupported"}
              onChange={(event) => {
                const { reasoningLevel: _reasoningLevel, ...rest } = value;
                void _reasoningLevel;
                onChange(
                  event.target.value === ""
                    ? rest
                    : {
                        ...rest,
                        reasoningLevel: event.target.value as ModelReasoningLevel,
                      },
                );
              }}
            >
              <option value="">{t("generation.inherit")}</option>
              {CHAT_REASONING_LEVELS.map((level) => (
                <option
                  key={level}
                  value={level}
                  disabled={capabilities?.reasoning.levels[level] === "unsupported"}
                >
                  {t(`generation.level.${level}`)}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="border-input bg-background hover:bg-accent text-foreground inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs"
        title={t("generation.title")}
      >
        <SlidersHorizontalIcon className="size-3.5" />
        {t("generation.title")}
      </button>
    </div>
  );
}
