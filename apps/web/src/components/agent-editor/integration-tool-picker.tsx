// SPDX-License-Identifier: Apache-2.0

/**
 * Per-integration tool/scope picker for the agent editor's Integrations section.
 *
 * `tools: undefined` and `tools: []` differ: `undefined` inherits the integration's
 * `default_tools` (§4.4), `[]` selects nothing. The first toggle promotes the inherited default
 * to an explicit array. "Select none" is allowed in a draft, but publish/import refuse it
 * (`no_tools_selected`) and a run aborts at sidecar boot; `tools.noneNotice` says so.
 * The `required` flag (§4.4) above it: set, a run refuses to start without a connection.
 */

import { toggleValue } from "../../lib/toggle-value";
import { type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react";
import {
  apiUploadToolNameFor,
  expandScopesGranted,
  getApiCallConfigs,
  readDefaultTools,
  resolveScopeToolSelection,
} from "@appstrate/core/integration";
import {
  isApiCallToolSelectionEnabled,
  replaceNativeToolSelection,
  toggleApiCallToolSelection,
} from "./tool-selection.ts";
import { cn } from "@appstrate/ui/cn";
import { Checkbox } from "@appstrate/ui/components/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@appstrate/ui/components/select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@appstrate/ui/components/collapsible";
import { Button } from "@appstrate/ui/components/button";
import { PackageToolCatalog } from "../package-detail/package-tool-catalog";
import { useIntegrationDetail } from "../../hooks/use-integrations";
import type { ResourceEntry } from "./types";
import { TextSkeleton } from "../loading-skeletons";

interface IntegrationToolPickerProps {
  packageId: string;
  entry: ResourceEntry;
  onChange: (next: ResourceEntry) => void;
}

/** Radix `Select` refuses an empty item value: this stands for "the integration's default auth". */
const DEFAULT_AUTH_KEY = "__default__";

export function IntegrationToolPicker(props: IntegrationToolPickerProps) {
  return (
    <>
      <RequiredIntegrationToggle {...props} />
      <IntegrationToolPanel {...props} />
    </>
  );
}

function RequiredIntegrationToggle({ packageId, entry, onChange }: IntegrationToolPickerProps) {
  const { t } = useTranslation("settings");
  const setRequired = (required: boolean) => {
    const next = { ...entry };
    if (required) next.required = true;
    else delete next.required;
    onChange(next);
  };
  return (
    <label
      className="mt-2 flex cursor-pointer items-start gap-2"
      data-testid={`integ-required-${packageId}`}
    >
      <Checkbox
        checked={entry.required === true}
        onCheckedChange={(v) => setRequired(v === true)}
        className="mt-0.5"
      />
      <span className="flex min-w-0 flex-col">
        <span className="text-xs font-semibold">
          {t("agentEditor.integrations.required.label")}
        </span>
        <span className="text-muted-foreground text-[11px]">
          {t("agentEditor.integrations.required.description")}
        </span>
      </span>
    </label>
  );
}

function IntegrationToolPanel({ packageId, entry, onChange }: IntegrationToolPickerProps) {
  const { t } = useTranslation("settings");
  const { data: detail, isLoading } = useIntegrationDetail(packageId);

  if (isLoading) {
    return <TextSkeleton lines={2} className="mt-2" />;
  }
  if (!detail) {
    return (
      <div className="bg-muted/30 text-muted-foreground mt-2 rounded-md border p-3 text-[11px]">
        {t("agentEditor.integrations.tools.detailUnavailable")}
      </div>
    );
  }

  // Server-resolved catalog; the integration's sparse `tools{}` policy table is not the source of "what exists".
  const fullCatalog = detail.tool_catalog ?? [];
  const fullCatalogNames = new Set(fullCatalog.map((tool) => tool.name));
  // api_call tools have their own rows. Their `api_upload` companions get none: the runtime grants
  // the pair together, so a separate checkbox could express a selection the resolver refuses.
  const apiCallConfigs = getApiCallConfigs(detail.manifest);
  const syntheticApiCallNames = new Set(apiCallConfigs.map((config) => config.toolName));
  const derivedSyntheticApiUploadNames = new Set(
    apiCallConfigs.flatMap((config) =>
      config.uploadToolName === undefined ? [] : [config.uploadToolName],
    ),
  );
  const visibleSyntheticApiUploadNames = new Set(
    [...derivedSyntheticApiUploadNames].filter((name) => fullCatalogNames.has(name)),
  );
  const apiCallEntries = fullCatalog.filter((tool) => syntheticApiCallNames.has(tool.name));
  const apiCallToolNames = apiCallEntries.map((t) => t.name);
  const visibleSyntheticToolNames = new Set([
    ...apiCallToolNames,
    ...visibleSyntheticApiUploadNames,
  ]);
  const nativeCatalog = fullCatalog.filter(
    (tool) =>
      !syntheticApiCallNames.has(tool.name) && !derivedSyntheticApiUploadNames.has(tool.name),
  );
  const declaredToolNames = nativeCatalog.map((t) => t.name);
  const hasToolCatalog = declaredToolNames.length > 0;

  // Mirrors the server's `resolveEffectiveToolSelection`: with no selection, the integration's
  // `default_tools` (§4.4) apply. Not written into the manifest until the author makes an explicit pick.
  const effectiveTools =
    entry.tools === undefined ? readDefaultTools(detail.manifest) : entry.tools;

  // `tools: "*"` (explicit or inherited) bypasses the per-tool picker.
  const wildcardSelected = effectiveTools === "*";

  // `auth_key` (§4.4) pins one of >1 auth methods; `undefined` keeps the resolver's default cascade.
  const authEntries = Object.entries(detail.manifest.auths ?? {});
  const hasMultipleAuths = authEntries.length > 1;
  const authMethodLabel = (key: string, auth: (typeof authEntries)[number][1]): string => {
    const a = auth as { title?: unknown; display_name?: unknown; type?: unknown };
    const title = typeof a.title === "string" ? a.title : undefined;
    const display = typeof a.display_name === "string" ? a.display_name : undefined;
    const type = typeof a.type === "string" ? a.type : undefined;
    const label = title ?? display ?? key;
    return type && type !== label ? `${label} (${type})` : label;
  };
  const onAuthKeyChange = (value: string) => {
    const next = value === "" ? undefined : value;
    onChange({ ...entry, auth_key: next });
  };

  const isApiCall = apiCallToolNames.length > 0;

  // One namespace across every auth, as the resolver sees it; first occurrence wins per `value`.
  const scopeCatalog = new Map<string, { value: string; label: string; description?: string }>();
  for (const auth of Object.values(detail.manifest.auths ?? {})) {
    for (const s of auth.scope_catalog ?? []) {
      if (!scopeCatalog.has(s.value)) scopeCatalog.set(s.value, s);
    }
  }
  const hasScopeCatalog = scopeCatalog.size > 0;

  // Wildcard falls back to an empty set so the checkbox lookups below stay safe.
  const arrayTools = Array.isArray(effectiveTools) ? [...new Set(effectiveTools)] : [];
  const selectedTools = new Set(arrayTools);
  const selectedScopes = new Set(entry.scopes ?? []);
  const allSelected =
    declaredToolNames.length > 0 && declaredToolNames.every((name) => selectedTools.has(name));
  // "Select none" clears the NATIVE slice only (api_call selections are preserved).
  const noneSelected = declaredToolNames.every((name) => !selectedTools.has(name));
  // Mirrors `selectsNoCallableTool` on the API side: the whole selection, api_call rows included.
  const selectsNothing = !wildcardSelected && arrayTools.length === 0;

  // Inferred OAuth scopes: the union of `required_scopes` of the tools the agent ITSELF selects
  // (`resolveScopeToolSelection`, the server's rule); tools inherited from `default_tools`
  // contribute none. The map keeps attribution for "required by: …". Wildcard skips inference
  // (the server uses the auth's `default_scopes`, shown via a dedicated notice).
  const catalogByName = new Map(fullCatalog.map((t) => [t.name, t]));
  const inferredScopes = new Map<string, string[]>();
  const scopeTools = resolveScopeToolSelection(entry.tools, detail.manifest);
  if (scopeTools !== "*") {
    for (const toolName of scopeTools) {
      const meta = catalogByName.get(toolName);
      for (const scope of Object.values(meta?.policy?.required_scopes ?? {}).flat()) {
        const existing = inferredScopes.get(scope) ?? [];
        if (!existing.includes(toolName)) existing.push(toolName);
        inferredScopes.set(scope, existing);
      }
    }
  }
  const hasInferredScopes = inferredScopes.size > 0;

  // Expand through the manifest's `implies` hierarchy (as the server does), so implied children
  // of an inferred scope are not offered as toggleable.
  const inferredExpanded = new Set<string>(inferredScopes.keys());
  const directInferred = [...inferredScopes.keys()];
  for (const authKey of Object.keys(detail.manifest.auths ?? {})) {
    for (const s of expandScopesGranted(directInferred, detail.manifest, authKey)) {
      inferredExpanded.add(s);
    }
  }

  // A pin that is also inferred shows as inferred; only the rest get a "(pinned)" badge.
  const pinnedOnlyScopes = [...selectedScopes].filter((s) => !inferredScopes.has(s));

  const toggleTool = (name: string) => {
    const next = toggleValue(arrayTools, name);
    onChange({ ...entry, tools: next });
  };

  // Toggles the api_call and its `api_upload` companion as one: the resolver grants both from either name.
  const toggleApiCallTool = (name: string) => {
    onChange({
      ...entry,
      tools: toggleApiCallToolSelection(arrayTools, name, visibleSyntheticApiUploadNames),
    });
  };

  // Wildcard (§4.4), gated by `allow_undeclared_tools`. OFF drops back to `[]`, like "Select none".
  const wildcardEnabled = detail.allow_undeclared_tools === true;
  const onWildcardChange = (next: boolean) => {
    onChange({ ...entry, tools: next ? "*" : [] });
  };

  const toggleScope = (value: string) => {
    const current = entry.scopes ?? [];
    const next = toggleValue(current, value);
    onChange({ ...entry, scopes: next.length > 0 ? next : undefined });
  };

  const setNative = (all: boolean) =>
    onChange({
      ...entry,
      tools: replaceNativeToolSelection(
        arrayTools,
        declaredToolNames,
        visibleSyntheticToolNames,
        all,
      ),
    });

  const wildcardControl = wildcardEnabled && (
    <div className="bg-background border-warning/30 rounded-md border-l-2 p-2">
      <label
        className="flex cursor-pointer items-start gap-2"
        data-testid={`integ-wildcard-${packageId}`}
      >
        <Checkbox
          checked={wildcardSelected}
          onCheckedChange={(v) => onWildcardChange(v === true)}
          className="mt-0.5"
        />
        <span className="flex min-w-0 flex-col">
          <span className="text-xs font-semibold">
            {t("agentEditor.integrations.wildcard.label")}
          </span>
          <span className="text-muted-foreground text-[11px]">
            {t("agentEditor.integrations.wildcard.description")}
          </span>
        </span>
      </label>
      {wildcardSelected && (
        <p className="text-muted-foreground mt-2 text-[11px]">
          {t("agentEditor.integrations.wildcard.scopesNotice")}
        </p>
      )}
    </div>
  );

  // Nothing to pick: render an explicit notice rather than `null` so an empty panel is explained.
  // Exception: `allow_undeclared_tools: true` with no catalog still needs the wildcard toggle.
  if (!hasToolCatalog && !hasScopeCatalog && !isApiCall && !hasMultipleAuths) {
    if (wildcardEnabled) {
      return (
        <div className="bg-muted/30 mt-2 flex flex-col gap-3 rounded-md border p-3">
          {wildcardControl}
        </div>
      );
    }
    return (
      <div className="bg-muted/30 text-muted-foreground mt-2 rounded-md border p-3 text-[11px]">
        {t("agentEditor.integrations.tools.noCatalog")}
      </div>
    );
  }

  return (
    <div className="bg-muted/30 mt-2 flex flex-col gap-3 rounded-md border p-3">
      {selectsNothing && (
        <p className="text-warning text-[11px]" data-testid={`integ-no-tools-${packageId}`}>
          {t("agentEditor.integrations.tools.noneNotice")}
        </p>
      )}
      {hasMultipleAuths && (
        <div>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-semibold">
              {t("agentEditor.integrations.authKey.label")}
            </span>
            <Select
              value={entry.auth_key ?? DEFAULT_AUTH_KEY}
              onValueChange={(key) => onAuthKeyChange(key === DEFAULT_AUTH_KEY ? "" : key)}
            >
              <SelectTrigger className="h-8 text-xs" data-testid={`integ-auth-key-${packageId}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT_AUTH_KEY}>
                  {t("agentEditor.integrations.authKey.default")}
                </SelectItem>
                {authEntries.map(([key, auth]) => (
                  <SelectItem key={key} value={key}>
                    {authMethodLabel(key, auth)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        </div>
      )}
      {wildcardControl}
      {!wildcardSelected &&
        isApiCall &&
        apiCallEntries.map((tool) => {
          // The `api_upload` companion is granted with its api_call sibling; the row label says so.
          const uploadToolName = apiUploadToolNameFor(tool.name);
          const withUpload = visibleSyntheticApiUploadNames.has(uploadToolName);
          const pairSelected = isApiCallToolSelectionEnabled(
            selectedTools,
            tool.name,
            visibleSyntheticApiUploadNames,
          );
          return (
            <label key={tool.name} className="flex cursor-pointer items-start gap-2">
              <Checkbox
                checked={pairSelected}
                onCheckedChange={() => toggleApiCallTool(tool.name)}
                data-testid={
                  apiCallEntries.length > 1
                    ? `integ-apicall-${packageId}-${tool.name}`
                    : `integ-apicall-${packageId}`
                }
              />
              <span className="flex flex-col">
                <span className="text-xs font-medium">
                  {t(
                    withUpload
                      ? "agentEditor.integrations.apiCall.labelWithUpload"
                      : "agentEditor.integrations.apiCall.label",
                  )}
                  {apiCallEntries.length > 1 ? ` · ${tool.name}` : ""}
                </span>
                <span className="text-muted-foreground text-[11px]">
                  {t(
                    withUpload
                      ? "agentEditor.integrations.apiCall.descriptionWithUpload"
                      : "agentEditor.integrations.apiCall.description",
                  )}
                </span>
              </span>
            </label>
          );
        })}
      {!wildcardSelected && hasToolCatalog && (
        <div>
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-xs font-semibold">
              {t("agentEditor.integrations.tools.title")}
            </span>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setNative(true)}
                disabled={allSelected}
                data-testid={`integ-tools-select-all-${packageId}`}
              >
                {t("models.form.discoverSelectAll")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setNative(false)}
                disabled={noneSelected}
                data-testid={`integ-tools-select-none-${packageId}`}
              >
                {t("apiKeys.deselectAll")}
              </Button>
            </div>
          </div>
          <p className="text-muted-foreground mb-2 text-[11px]">
            {t("agentEditor.integrations.tools.explicitNotice")}
          </p>
          <PackageToolCatalog
            tools={nativeCatalog.map((tool) => ({
              name: tool.name,
              description: tool.description,
              permissions: tool.policy?.required_scopes,
            }))}
            selection={{ values: selectedTools, onToggle: toggleTool }}
          />
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
                <ScopeChip
                  key={scope}
                  scope={scope}
                  testId={`integ-inferred-scope-${packageId}-${scope}`}
                  title={
                    t("agentEditor.integrations.scopes.requiredBy", {
                      tools: tools.join(", "),
                    }) + (meta?.description ? ` — ${meta.description}` : "")
                  }
                >
                  {tools.length === 1
                    ? t("agentEditor.integrations.scopes.requiredBy1", { tool: tools[0] })
                    : t("agentEditor.integrations.scopes.requiredByN", { count: tools.length })}
                </ScopeChip>
              );
            })}
            {pinnedOnlyScopes.map((scope) => (
              <ScopeChip
                key={scope}
                dashed
                scope={scope}
                testId={`integ-pinned-scope-${packageId}-${scope}`}
                title={t("agentEditor.integrations.scopes.pinnedHint")}
              >
                {t("agentEditor.integrations.scopes.pinnedBadge")}
              </ScopeChip>
            ))}
          </div>
        </div>
      )}

      {hasScopeCatalog && (
        <Collapsible>
          <CollapsibleTrigger
            type="button"
            className="group text-muted-foreground hover:text-foreground -mx-1 flex items-center gap-1 px-1 py-0.5 text-xs font-semibold"
            data-testid={`integ-advanced-toggle-${packageId}`}
          >
            <ChevronRight className="size-3 group-data-[state=open]:rotate-90" />
            {t("agentEditor.integrations.scopes.advancedToggle")}
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2">
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
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}

/** A scope the selection needs (solid) or that is pinned by hand (dashed). */
function ScopeChip({
  dashed,
  scope,
  testId,
  title,
  children,
}: {
  dashed?: boolean;
  scope: string;
  testId: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "bg-background inline-flex items-center gap-1.5 rounded border px-1.5 py-0.5 text-[11px]",
        dashed && "border-dashed",
      )}
      data-testid={testId}
      title={title}
    >
      <span className="font-mono">{scope}</span>
      <span className="text-muted-foreground text-[10px]">{children}</span>
    </span>
  );
}
