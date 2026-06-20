// SPDX-License-Identifier: Apache-2.0

/**
 * Model/provider picker shown under the composer input — ported from the
 * appstrate-chat satellite (ModelSelect.tsx + models.ts helper). Lists the
 * org's configured models (`GET /api/models`, the same catalog the server
 * resolves against) and surfaces the chosen preset id; the panel forwards
 * it per turn via the `X-Model-Id` header.
 */

import { useEffect, useRef, useState } from "react";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { CHAT_USABLE_FAMILIES } from "../chat-families.ts";

export interface OrgModelOption {
  id: string;
  /** `null` for model aliases — the real binding is hidden from the browser. */
  modelId: string | null;
  /** `null` for model aliases — the backing protocol is hidden from the browser. */
  apiShape: string | null;
  providerId?: string | null;
  label: string | null;
  isDefault?: boolean;
  enabled?: boolean;
  /** Model-alias flag — selectable in chat without exposing the backing model. */
  aliased?: boolean;
}

/** Group/button label for an alias — provider-neutral so the backing stays hidden. */
const ALIAS_LABEL = "Alias";

export async function fetchModels(
  getHeaders?: () => Record<string, string>,
): Promise<OrgModelOption[]> {
  try {
    const res = await fetch("/api/models", {
      credentials: "include",
      headers: { ...getHeaders?.() },
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { models?: OrgModelOption[]; data?: OrgModelOption[] };
    // Same family gate as the server (pickModel in llm.ts) — shared set so they
    // never drift. claude-code is selectable via its anthropic-messages
    // apiShape; the server routes it to the Claude Agent SDK engine by
    // providerId.
    //
    // Model aliases reach this cookie-authed surface with their backing stripped
    // (`apiShape: null`), so the family gate can't see it — but they're meant to
    // be usable in chat (the user picks the alias; the server resolves the real
    // model). Always include enabled aliases; the loopback `pickModel` does the
    // authoritative family check against the real (unstripped) backing.
    return (body.models ?? body.data ?? []).filter(
      (m) =>
        m.enabled !== false &&
        (m.aliased === true || (!!m.apiShape && CHAT_USABLE_FAMILIES.has(m.apiShape))),
    );
  } catch {
    return [];
  }
}

const PROVIDERS: Record<string, string> = {
  "anthropic-messages": "Anthropic",
  "openai-completions": "OpenAI",
  "mistral-conversations": "Mistral",
};

function providerLabel(model: {
  apiShape: string | null;
  providerId?: string | null;
  aliased?: boolean;
}): string {
  // Aliases hide their backing — group/badge them neutrally, never by the real
  // provider/protocol (which is null on the browser-facing projection anyway).
  if (model.aliased) return ALIAS_LABEL;
  if (model.providerId === "claude-code") return "Claude Code";
  return (model.apiShape && PROVIDERS[model.apiShape]) || ALIAS_LABEL;
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
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => {
                      onSelect(m.id);
                      setOpen(false);
                    }}
                    className={`flex w-full items-center justify-start gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
                      isSelected
                        ? "bg-accent text-accent-foreground"
                        : "hover:bg-accent hover:text-accent-foreground"
                    }`}
                  >
                    <CheckIcon
                      className={`size-3.5 shrink-0 ${isSelected ? "opacity-100" : "opacity-0"}`}
                    />
                    <span className="flex-1 truncate text-left">{m.label ?? m.modelId}</span>
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
          <>
            <span className="text-muted-foreground shrink-0">{providerLabel(active)}</span>
            <span className="truncate font-medium">{active.label ?? active.modelId}</span>
          </>
        ) : (
          <span className="font-medium">Modèle</span>
        )}
        <ChevronDownIcon className="text-muted-foreground size-3.5 shrink-0" />
      </button>
    </div>
  );
}
