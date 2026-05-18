// SPDX-License-Identifier: Apache-2.0

/**
 * Niveau 2 (Phase 5b) — per-integration tool/scope picker rendered
 * inside the agent editor's Integrations section. Lets the agent author
 * narrow which MCP tools the integration exposes to the agent at
 * runtime (drives `IntegrationSpawnSpec.toolAllowlist` → sidecar
 * `McpHost.allowedTools`) and optionally pin extra OAuth scopes beyond
 * those inferred from the tool selection.
 *
 * Visibility rules (intentional — keeps the surface tiny when there's
 * nothing meaningful to pick):
 *   - Tool picker shown only when the integration's manifest declares
 *     a `tools` block. Older integrations without per-tool metadata
 *     stay on the legacy "all tools allowed" default.
 *   - Scope picker shown only when at least one auth declares an
 *     `availableScopes` catalog. Bare scope strings (no catalog) are
 *     opaque to the UI — operators have to hand-edit the manifest.
 *
 * Writes back through the `onChange` callback handed in by
 * `ResourceSection`; the resulting `ResourceEntry` is then translated
 * to the niveau 2 rich form by `setResourceEntries('integrations')`.
 */

import { useTranslation } from "react-i18next";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "../spinner";
import { useIntegrationDetail } from "../../hooks/use-integrations";
import type { ResourceEntry } from "./types";

interface IntegrationToolPickerProps {
  packageId: string;
  entry: ResourceEntry;
  onChange: (next: ResourceEntry) => void;
}

export function IntegrationToolPicker({ packageId, entry, onChange }: IntegrationToolPickerProps) {
  const { t } = useTranslation("settings");
  const { data: detail, isLoading } = useIntegrationDetail(packageId);

  if (isLoading) {
    return (
      <div className="mt-2 flex items-center justify-center py-2">
        <Spinner />
      </div>
    );
  }
  if (!detail) return null;

  const declaredTools = detail.manifest.tools ?? {};
  const declaredToolNames = Object.keys(declaredTools);
  const hasToolCatalog = declaredToolNames.length > 0;

  // Aggregate scope catalog across every auth — the resolver treats them
  // as a single namespace per integration (Phase 0). Dedup by `value`,
  // keep the first occurrence's label/description.
  const scopeCatalog = new Map<string, { value: string; label: string; description?: string }>();
  for (const auth of Object.values(detail.manifest.auths ?? {})) {
    for (const s of auth.availableScopes ?? []) {
      if (!scopeCatalog.has(s.value)) scopeCatalog.set(s.value, s);
    }
  }
  const hasScopeCatalog = scopeCatalog.size > 0;

  // `entry.tools === undefined` means "legacy — all tools allowed".
  // The first toggle promotes the entry to the rich form (explicit set).
  // An empty `[]` is a valid explicit lockdown.
  const selectedTools = new Set(entry.tools ?? []);
  const selectedScopes = new Set(entry.scopes ?? []);

  const toggleTool = (name: string) => {
    // Promote `undefined` → `[]` on first toggle so subsequent renders
    // see the explicit form; the user's first click is the consent to
    // niveau 2 enforcement for this integration.
    const current = entry.tools ?? [];
    const next = current.includes(name) ? current.filter((t) => t !== name) : [...current, name];
    onChange({ ...entry, tools: next });
  };

  const toggleScope = (value: string) => {
    const current = entry.scopes ?? [];
    const next = current.includes(value) ? current.filter((s) => s !== value) : [...current, value];
    onChange({ ...entry, scopes: next.length > 0 ? next : undefined });
  };

  const resetTools = () => {
    const { tools: _tools, ...rest } = entry;
    onChange(rest);
  };

  if (!hasToolCatalog && !hasScopeCatalog) return null;

  return (
    <div
      className="bg-muted/30 mt-2 space-y-3 rounded-md border p-3"
      onClick={(e) => e.stopPropagation()}
    >
      {hasToolCatalog && (
        <div>
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-xs font-semibold">
              {t("agentEditor.integrations.tools.title")}
            </span>
            {entry.tools !== undefined && (
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground text-[10px] underline"
                onClick={resetTools}
              >
                {t("agentEditor.integrations.tools.reset")}
              </button>
            )}
          </div>
          <p className="text-muted-foreground mb-2 text-[11px]">
            {entry.tools === undefined
              ? t("agentEditor.integrations.tools.legacyNotice")
              : t("agentEditor.integrations.tools.explicitNotice")}
          </p>
          <div className="grid gap-1.5">
            {declaredToolNames.map((name) => {
              const meta = declaredTools[name];
              return (
                <label
                  key={name}
                  className="flex cursor-pointer items-start gap-2 text-xs"
                  data-testid={`integ-tool-${packageId}-${name}`}
                >
                  <Checkbox
                    checked={selectedTools.has(name)}
                    onCheckedChange={() => toggleTool(name)}
                    className="mt-0.5"
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className="font-mono">{name}</span>
                    {meta?.requiredScopes && meta.requiredScopes.length > 0 && (
                      <span className="text-muted-foreground">
                        {t("agentEditor.integrations.tools.requires")}{" "}
                        <span className="font-mono">{meta.requiredScopes.join(", ")}</span>
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      )}

      {hasScopeCatalog && (
        <div>
          <span className="mb-2 block text-xs font-semibold">
            {t("agentEditor.integrations.scopes.title")}
          </span>
          <p className="text-muted-foreground mb-2 text-[11px]">
            {t("agentEditor.integrations.scopes.notice")}
          </p>
          <div className="grid gap-1.5">
            {[...scopeCatalog.values()].map((s) => (
              <label
                key={s.value}
                className="flex cursor-pointer items-start gap-2 text-xs"
                data-testid={`integ-scope-${packageId}-${s.value}`}
              >
                <Checkbox
                  checked={selectedScopes.has(s.value)}
                  onCheckedChange={() => toggleScope(s.value)}
                  className="mt-0.5"
                />
                <span className="flex min-w-0 flex-col">
                  <span>
                    {s.label} <span className="text-muted-foreground font-mono">({s.value})</span>
                  </span>
                  {s.description && <span className="text-muted-foreground">{s.description}</span>}
                </span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
