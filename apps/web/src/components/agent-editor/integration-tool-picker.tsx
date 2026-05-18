// SPDX-License-Identifier: Apache-2.0

/**
 * Niveau 2 (Phase 5b) — per-integration tool/scope picker rendered
 * inside the agent editor's Integrations section. Lets the agent author
 * narrow which MCP tools the integration exposes to the agent at
 * runtime (drives `IntegrationSpawnSpec.toolAllowlist` → sidecar
 * `McpHost.allowedTools`) and optionally pin extra OAuth scopes beyond
 * those inferred from the tool selection.
 *
 * Display hierarchy (Phase 5b.2 — niveau 2 polish):
 *   1. Tool checkboxes — the primary surface. The author picks tools.
 *   2. Inferred OAuth scopes — read-only badges, computed from the
 *      selected tools' `requiredScopes`, with per-scope attribution
 *      ("required by: create_pull_request, delete_file"). This is the
 *      authoritative scope set the OAuth kickoff will request — what
 *      the author sees here is what `computeRequiredScopes` will union.
 *   3. Advanced disclosure — the explicit `scopes[]` escape hatch,
 *      collapsed by default. Covers the four edge cases that tool
 *      inference can't reach (orthogonal scopes like `user:email`,
 *      future-proofing, under-declared tools, legacy "all tools" mode).
 *
 * Visibility rules (intentional — keeps the surface tiny when there's
 * nothing meaningful to pick):
 *   - Tool picker shown only when the integration's manifest declares
 *     a `tools` block. Older integrations without per-tool metadata
 *     stay on the legacy "all tools allowed" default.
 *   - Inferred-scopes section shown only when at least one tool
 *     contributes a requiredScope (so empty selections / scope-less
 *     manifests don't render an empty box).
 *   - Advanced disclosure shown only when at least one auth declares an
 *     `availableScopes` catalog. Bare scope strings (no catalog) are
 *     opaque to the UI — operators have to hand-edit the manifest.
 *
 * Writes back through the `onChange` callback handed in by
 * `ResourceSection`; the resulting `ResourceEntry` is then translated
 * to the niveau 2 rich form by `setResourceEntries('integrations')`.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight } from "lucide-react";
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
  const [advancedOpen, setAdvancedOpen] = useState(false);

  if (isLoading) {
    return (
      <div className="mt-2 flex items-center justify-center py-2">
        <Spinner />
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="bg-muted/30 text-muted-foreground mt-2 rounded-md border p-3 text-[11px]">
        {t("agentEditor.integrations.tools.detailUnavailable")}
      </div>
    );
  }

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

  // Inferred OAuth scopes — exactly what Phase 2 `computeRequiredScopes`
  // will union into the OAuth kickoff. Two cases:
  //   - entry.tools === undefined (legacy) → contributes the union of
  //     EVERY declared tool's requiredScopes, mirroring the server-side
  //     "all tools allowed" semantics.
  //   - entry.tools defined → contributes the union of selected tools'
  //     requiredScopes only.
  // Map keeps attribution (which tools required each scope) so the
  // badges can show "required by: …".
  const inferredScopes = new Map<string, string[]>();
  const contributingToolNames = entry.tools === undefined ? declaredToolNames : (entry.tools ?? []);
  for (const toolName of contributingToolNames) {
    const meta = declaredTools[toolName];
    for (const scope of meta?.requiredScopes ?? []) {
      const existing = inferredScopes.get(scope) ?? [];
      if (!existing.includes(toolName)) existing.push(toolName);
      inferredScopes.set(scope, existing);
    }
  }
  const hasInferredScopes = inferredScopes.size > 0;

  // Pinned scopes that aren't already inferred — surface them as
  // "(pinned)" badges to make the union visible. Pinned scopes that
  // ARE also inferred get the inferred attribution (no point showing
  // "pinned" — the tool selection already covers them, the pin is redundant
  // but harmless).
  const pinnedOnlyScopes = [...selectedScopes].filter((s) => !inferredScopes.has(s));

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

  // Niveau 2 contract: when the integration manifest declares neither a
  // `tools` block nor any `availableScopes` catalog, there is literally
  // nothing for the agent author to pick — every tool is allowed and
  // scopes default to `auths.{key}.scopes`. Render an explicit notice
  // (rather than `return null`) so the user understands why the panel
  // is empty and can debug "the gmail integration shows nothing"
  // without grepping the codebase — typical root cause is a DB
  // manifest that predates the niveau 2 fields and needs a server
  // reboot to drift-heal.
  if (!hasToolCatalog && !hasScopeCatalog) {
    return (
      <div className="bg-muted/30 text-muted-foreground mt-2 rounded-md border p-3 text-[11px]">
        {t("agentEditor.integrations.tools.noCatalog")}
      </div>
    );
  }

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

      {(hasInferredScopes || pinnedOnlyScopes.length > 0) && (
        <div data-testid={`integ-inferred-scopes-${packageId}`}>
          <span className="mb-2 block text-xs font-semibold">
            {t("agentEditor.integrations.scopes.inferredTitle")}
          </span>
          <p className="text-muted-foreground mb-2 text-[11px]">
            {entry.tools === undefined
              ? t("agentEditor.integrations.scopes.inferredFromAll")
              : t("agentEditor.integrations.scopes.inferredFromSelection")}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {[...inferredScopes.entries()].map(([scope, tools]) => {
              const meta = scopeCatalog.get(scope);
              return (
                <span
                  key={scope}
                  className="bg-background inline-flex items-center gap-1.5 rounded border px-1.5 py-0.5 text-[11px]"
                  data-testid={`integ-inferred-scope-${packageId}-${scope}`}
                  title={
                    t("agentEditor.integrations.scopes.requiredBy", {
                      tools: tools.join(", "),
                    }) + (meta?.description ? ` — ${meta.description}` : "")
                  }
                >
                  <span className="font-mono">{scope}</span>
                  <span className="text-muted-foreground text-[10px]">
                    {tools.length === 1
                      ? t("agentEditor.integrations.scopes.requiredBy1", { tool: tools[0] })
                      : t("agentEditor.integrations.scopes.requiredByN", { count: tools.length })}
                  </span>
                </span>
              );
            })}
            {pinnedOnlyScopes.map((scope) => (
              <span
                key={scope}
                className="bg-background inline-flex items-center gap-1.5 rounded border border-dashed px-1.5 py-0.5 text-[11px]"
                data-testid={`integ-pinned-scope-${packageId}-${scope}`}
                title={t("agentEditor.integrations.scopes.pinnedHint")}
              >
                <span className="font-mono">{scope}</span>
                <span className="text-muted-foreground text-[10px]">
                  {t("agentEditor.integrations.scopes.pinnedBadge")}
                </span>
              </span>
            ))}
          </div>
        </div>
      )}

      {hasScopeCatalog && (
        <div>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground -mx-1 flex items-center gap-1 px-1 py-0.5 text-xs font-semibold"
            onClick={() => setAdvancedOpen((v) => !v)}
            aria-expanded={advancedOpen}
            data-testid={`integ-advanced-toggle-${packageId}`}
          >
            {advancedOpen ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            {t("agentEditor.integrations.scopes.advancedToggle")}
          </button>
          {advancedOpen && (
            <div className="mt-2">
              <p className="text-muted-foreground mb-2 text-[11px]">
                {t("agentEditor.integrations.scopes.advancedNotice")}
              </p>
              <div className="grid gap-1.5">
                {[...scopeCatalog.values()].map((s) => {
                  const inferredBy = inferredScopes.get(s.value);
                  return (
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
                          {s.label}{" "}
                          <span className="text-muted-foreground font-mono">({s.value})</span>
                          {inferredBy && (
                            <span className="text-muted-foreground ml-1 text-[10px]">
                              {t("agentEditor.integrations.scopes.alreadyInferred")}
                            </span>
                          )}
                        </span>
                        {s.description && (
                          <span className="text-muted-foreground">{s.description}</span>
                        )}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
