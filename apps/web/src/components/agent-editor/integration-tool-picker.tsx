// SPDX-License-Identifier: Apache-2.0

/**
 * Niveau 2 — per-integration tool/scope picker rendered inside the agent
 * editor's Integrations section. Drives
 * `IntegrationSpawnSpec.toolAllowlist` → sidecar `McpHost.allowedTools`
 * (Phase 3) and optionally pins extra OAuth scopes beyond those
 * inferred from the tool selection.
 *
 * Least-privilege contract: the runtime treats `tools: undefined` and
 * `tools: []` identically (0 tools exposed). The picker surfaces
 * "Select all" / "Select none" buttons so the author can flip the
 * common cases in one click; per-tool checkboxes handle the fine
 * grain. The first toggle promotes `undefined → []` so subsequent
 * renders see the explicit form.
 *
 * The picker writes back through `onChange` (handed in by
 * `ResourceSection`); the resulting `ResourceEntry` is translated to
 * the manifest's top-level `integrations[id]` block by
 * `setResourceEntries('integrations')`.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  expandGrantedScopes,
  getApiCallConfig,
  API_CALL_TOOL_NAME,
} from "@appstrate/core/integration";
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

  // apiCall integrations expose the generic `api_call` tool, which the runtime
  // injects only when it's present in the agent's `tools[]`. Default it on when
  // the integration is freshly added (`tools` still undefined) so the
  // integration works out of the box; the user can uncheck it below.
  useEffect(() => {
    if (!detail || getApiCallConfig(detail.manifest) === null) return;
    if (entry.tools !== undefined) return;
    onChange({ ...entry, tools: [API_CALL_TOOL_NAME] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail, entry.tools]);

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

  // apiCall integrations (former providers) expose the generic `api_call`
  // tool instead of discrete MCP tools. Surface it as a selectable tool so
  // the agent author can opt in (the runtime gates injection on it).
  const isApiCall = getApiCallConfig(detail.manifest) !== null;
  const apiCallSelected = (entry.tools ?? []).includes(API_CALL_TOOL_NAME);
  const toggleApiCall = () => {
    const current = entry.tools ?? [];
    const next = current.includes(API_CALL_TOOL_NAME)
      ? current.filter((tool) => tool !== API_CALL_TOOL_NAME)
      : [...current, API_CALL_TOOL_NAME];
    onChange({ ...entry, tools: next });
  };

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

  // Least-privilege: `entry.tools === undefined` and `entry.tools === []`
  // both mean "0 tools picked, integration inert at runtime". The first
  // toggle promotes to `[]`-then-add so subsequent renders see the
  // explicit form.
  const selectedTools = new Set(entry.tools ?? []);
  const selectedScopes = new Set(entry.scopes ?? []);
  const allSelected =
    selectedTools.size === declaredToolNames.length && declaredToolNames.length > 0;
  const noneSelected = selectedTools.size === 0;

  // Inferred OAuth scopes — exactly what Phase 2 `computeRequiredScopes`
  // will union into the OAuth kickoff. Contributes the union of
  // selected tools' requiredScopes only (`undefined`/`[]` selection
  // contributes nothing). Map keeps attribution for "required by: …".
  const inferredScopes = new Map<string, string[]>();
  for (const toolName of entry.tools ?? []) {
    const meta = declaredTools[toolName];
    for (const scope of meta?.requiredScopes ?? []) {
      const existing = inferredScopes.get(scope) ?? [];
      if (!existing.includes(toolName)) existing.push(toolName);
      inferredScopes.set(scope, existing);
    }
  }
  const hasInferredScopes = inferredScopes.size > 0;

  // Transitively expand the inferred set through the manifest's `implies`
  // hierarchy (mirrors `expandGrantedScopes` used server-side for missing-
  // scope diffs). Without this, `repo` would be flagged as inferred but
  // its implied children (`repo:status`, `repo_deployment`) would render
  // as toggleable — even though the OAuth grant already covers them.
  const inferredExpanded = new Set<string>(inferredScopes.keys());
  const directInferred = [...inferredScopes.keys()];
  for (const authKey of Object.keys(detail.manifest.auths ?? {})) {
    for (const s of expandGrantedScopes(directInferred, detail.manifest, authKey)) {
      inferredExpanded.add(s);
    }
  }

  // Pinned scopes that aren't already inferred — surface them as
  // "(pinned)" badges to make the union visible. Pinned scopes that
  // ARE also inferred get the inferred attribution (no point showing
  // "pinned" — the tool selection already covers them, the pin is redundant
  // but harmless).
  const pinnedOnlyScopes = [...selectedScopes].filter((s) => !inferredScopes.has(s));

  const toggleTool = (name: string) => {
    const current = entry.tools ?? [];
    const next = current.includes(name) ? current.filter((t) => t !== name) : [...current, name];
    onChange({ ...entry, tools: next });
  };

  const toggleScope = (value: string) => {
    const current = entry.scopes ?? [];
    const next = current.includes(value) ? current.filter((s) => s !== value) : [...current, value];
    onChange({ ...entry, scopes: next.length > 0 ? next : undefined });
  };

  const selectAllTools = () => onChange({ ...entry, tools: [...declaredToolNames] });
  const selectNoTools = () => onChange({ ...entry, tools: [] });

  // Niveau 2 contract: when the integration manifest declares neither a
  // `tools` block nor any `availableScopes` catalog, there is literally
  // nothing for the agent author to pick — every tool is allowed and
  // scopes default to `auths.{key}.scopes`. Render an explicit notice
  // (rather than `return null`) so the user understands why the panel
  // is empty and can debug "the gmail integration shows nothing"
  // without grepping the codebase — typical root cause is a DB
  // manifest that predates the niveau 2 fields and needs a server
  // reboot to drift-heal.
  if (!hasToolCatalog && !hasScopeCatalog && !isApiCall) {
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
      {isApiCall && (
        <label className="flex cursor-pointer items-start gap-2">
          <Checkbox
            checked={apiCallSelected}
            onCheckedChange={toggleApiCall}
            data-testid={`integ-apicall-${packageId}`}
          />
          <span className="flex flex-col">
            <span className="text-xs font-medium">
              {t("agentEditor.integrations.apiCall.label")}
            </span>
            <span className="text-muted-foreground text-[11px]">
              {t("agentEditor.integrations.apiCall.description")}
            </span>
          </span>
        </label>
      )}
      {hasToolCatalog && (
        <div>
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-xs font-semibold">
              {t("agentEditor.integrations.tools.title")}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground text-[10px] underline disabled:cursor-not-allowed disabled:no-underline disabled:opacity-50"
                onClick={selectAllTools}
                disabled={allSelected}
                data-testid={`integ-tools-select-all-${packageId}`}
              >
                {t("agentEditor.integrations.tools.selectAll")}
              </button>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground text-[10px] underline disabled:cursor-not-allowed disabled:no-underline disabled:opacity-50"
                onClick={selectNoTools}
                disabled={noneSelected}
                data-testid={`integ-tools-select-none-${packageId}`}
              >
                {t("agentEditor.integrations.tools.selectNone")}
              </button>
            </div>
          </div>
          <p className="text-muted-foreground mb-2 text-[11px]">
            {noneSelected
              ? t("agentEditor.integrations.tools.noneNotice")
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
            {t("agentEditor.integrations.scopes.inferredFromSelection")}
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
                  const isInferred = inferredExpanded.has(s.value);
                  const checked = isInferred || selectedScopes.has(s.value);
                  return (
                    <label
                      key={s.value}
                      className={`flex items-start gap-2 text-xs ${
                        isInferred ? "cursor-not-allowed opacity-60" : "cursor-pointer"
                      }`}
                      data-testid={`integ-scope-${packageId}-${s.value}`}
                    >
                      <Checkbox
                        checked={checked}
                        disabled={isInferred}
                        onCheckedChange={isInferred ? undefined : () => toggleScope(s.value)}
                        className="mt-0.5"
                      />
                      <span className="flex min-w-0 flex-col">
                        <span>
                          {s.label}{" "}
                          <span className="text-muted-foreground font-mono">({s.value})</span>
                          {isInferred && (
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
