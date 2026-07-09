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
 * `ResourceSection`); the resulting `ResourceEntry` is split into the
 * `dependencies.integrations[id]` version (§4.1) and the
 * `integrations_configuration[id]` selection (§4.4) by
 * `setResourceEntries('integrations')`.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  expandScopesGranted,
  isApiCallToolName,
  isApiUploadToolName,
  readDefaultTools,
  toggleApiCallToolSelection,
} from "@appstrate/core/integration";
import { Checkbox } from "@appstrate/ui/components/checkbox";
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

  // Effective agent-facing tool catalog. Resolved server-side from the
  // referenced mcp-server's MCPB `tools[]` minus `hidden_tools` and
  // auto-hidden connect.tool primitives — the integration's sparse
  // `tools{}` policy table is no longer the source of truth for "what
  // exists" (it only carries per-tool policy when present).
  const fullCatalog = detail.tool_catalog ?? [];
  // The api_call tool(s) have their own dedicated checkbox row(s); exclude
  // them from the native tools list so they don't render twice. Their
  // `api_upload` companions get no row of their own: the runtime grants the
  // pair together (each upload chunk is dispatched through the sibling
  // api_call tool), so a separate checkbox could only express a selection the
  // resolver refuses to honour.
  const catalogToolNames = fullCatalog.map((t) => t.name);
  const apiCallEntries = fullCatalog.filter((t) => isApiCallToolName(t.name));
  const apiCallToolNames = apiCallEntries.map((t) => t.name);
  const nativeCatalog = fullCatalog.filter(
    (t) => !isApiCallToolName(t.name) && !isApiUploadToolName(t.name),
  );
  const declaredToolNames = nativeCatalog.map((t) => t.name);
  const hasToolCatalog = declaredToolNames.length > 0;

  // Reflect the server's `resolveEffectiveToolSelection`: when the agent
  // declared no selection (`tools === undefined`, i.e. no
  // `integrations_configuration.<id>`), the runtime inherits the integration's
  // declared `default_tools` (AFPS §4.4). Mirror that here so the picker shows
  // what will actually run — generically, from whatever the integration
  // declares, with no hard-coded api_call special-casing. The default is NOT
  // materialised into the manifest: the inheritance is preserved until the
  // author makes an explicit pick, and the first toggle/Select-* promotes it to
  // an explicit array (which overrides the default, mirroring runtime
  // precedence). An explicit selection — including `[]` and `"*"` — passes
  // through untouched.
  const effectiveTools =
    entry.tools === undefined ? readDefaultTools(detail.manifest) : entry.tools;

  // AFPS §4.4 wildcard — `tools: "*"` (explicit, or inherited from a wildcard
  // `default_tools`) bypasses the per-tool picker. Tracked separately because
  // the wildcard and the array form share the same field but the UI branches.
  const wildcardSelected = effectiveTools === "*";

  // Multi-auth surface (AFPS §4.4 `auth_key`): when the integration
  // declares >1 auth method, the agent author can pin which `auths.<key>`
  // this dep uses at runtime. `undefined` keeps the resolver cascade's
  // default behaviour (any accessible connection wins).
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

  // api_call integrations expose generic credential-injecting tool(s) (one per
  // auth opted into the `_meta["dev.appstrate/api"]` extension) instead of, or
  // alongside, discrete MCP tools. Surface each as a selectable tool so the
  // agent author can opt in (the runtime gates injection on the selection).
  const isApiCall = apiCallToolNames.length > 0;

  // Aggregate scope catalog across every auth — the resolver treats them
  // as a single namespace per integration (Phase 0). Dedup by `value`,
  // keep the first occurrence's label/description.
  const scopeCatalog = new Map<string, { value: string; label: string; description?: string }>();
  for (const auth of Object.values(detail.manifest.auths ?? {})) {
    for (const s of auth.scope_catalog ?? []) {
      if (!scopeCatalog.has(s.value)) scopeCatalog.set(s.value, s);
    }
  }
  const hasScopeCatalog = scopeCatalog.size > 0;

  // Least-privilege: an explicit `entry.tools === []` still means "0 tools
  // picked, integration inert at runtime". `undefined` is reflected through
  // `effectiveTools` above so an inherited `default_tools` shows as checked
  // without being written back; the first toggle promotes that to an explicit
  // array. The wildcard form `"*"` short-circuits the picker (see
  // `wildcardSelected` above) — fall back to an empty set so the checkbox
  // lookups below stay safe.
  const arrayTools = Array.isArray(effectiveTools) ? effectiveTools : [];
  const selectedTools = new Set(arrayTools);
  const selectedScopes = new Set(entry.scopes ?? []);
  const allSelected =
    selectedTools.size === declaredToolNames.length && declaredToolNames.length > 0;
  const noneSelected = selectedTools.size === 0;

  // Inferred OAuth scopes — exactly what Phase 2 `computeRequiredScopes`
  // will union into the OAuth kickoff. Contributes the union of
  // selected tools' requiredScopes only (`undefined`/`[]` selection
  // contributes nothing). Map keeps attribution for "required by: …".
  // Policy lookup goes through the resolved catalog: a tool without
  // policy contributes nothing (expected — most discoverable tools have
  // no scope requirements).
  //
  // Wildcard path (`tools: "*"`) skips per-tool inference entirely — the
  // server-side resolver uses the auth's `default_scopes` instead, which
  // is shown to the user via a dedicated notice rather than the attribution
  // map.
  const catalogByName = new Map(fullCatalog.map((t) => [t.name, t]));
  const inferredScopes = new Map<string, string[]>();
  if (!wildcardSelected) {
    for (const toolName of arrayTools) {
      const meta = catalogByName.get(toolName);
      for (const scope of Object.values(meta?.policy?.required_scopes ?? {}).flat()) {
        const existing = inferredScopes.get(scope) ?? [];
        if (!existing.includes(toolName)) existing.push(toolName);
        inferredScopes.set(scope, existing);
      }
    }
  }
  const hasInferredScopes = inferredScopes.size > 0;

  // Transitively expand the inferred set through the manifest's `implies`
  // hierarchy (mirrors `expandScopesGranted` used server-side for missing-
  // scope diffs). Without this, `repo` would be flagged as inferred but
  // its implied children (`repo:status`, `repo_deployment`) would render
  // as toggleable — even though the OAuth grant already covers them.
  const inferredExpanded = new Set<string>(inferredScopes.keys());
  const directInferred = [...inferredScopes.keys()];
  for (const authKey of Object.keys(detail.manifest.auths ?? {})) {
    for (const s of expandScopesGranted(directInferred, detail.manifest, authKey)) {
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
    // Defensive: the per-tool checkboxes are hidden when `wildcardSelected`,
    // but a stray click during render race shouldn't silently corrupt the
    // wildcard with an array. Treat `"*"` as no-op here.
    if (wildcardSelected) return;
    const current = arrayTools;
    const next = current.includes(name) ? current.filter((t) => t !== name) : [...current, name];
    onChange({ ...entry, tools: next });
  };

  // api_call rows carry their `api_upload` companion (when the integration
  // declared `upload_protocols`) so the written selection matches what the
  // runtime will expose. Toggling the pair as one keeps the manifest honest —
  // the resolver grants both from either name, and a half-selection would read
  // as a capability the agent doesn't have.
  const toggleApiCallTool = (name: string) => {
    if (wildcardSelected) return;
    onChange({ ...entry, tools: toggleApiCallToolSelection(arrayTools, name, catalogToolNames) });
  };

  // Wildcard toggle (AFPS §4.4) — gated by `detail.allow_undeclared_tools`.
  // ON: replace any array selection with `"*"`. OFF: drop back to an empty
  // array, mirroring "Select none" (the user re-picks tools individually).
  const wildcardEnabled = detail.allow_undeclared_tools === true;
  const onWildcardChange = (next: boolean) => {
    onChange({ ...entry, tools: next ? "*" : [] });
  };

  const toggleScope = (value: string) => {
    const current = entry.scopes ?? [];
    const next = current.includes(value) ? current.filter((s) => s !== value) : [...current, value];
    onChange({ ...entry, scopes: next.length > 0 ? next : undefined });
  };

  const selectAllTools = () => onChange({ ...entry, tools: [...declaredToolNames] });
  const selectNoTools = () => onChange({ ...entry, tools: [] });

  // Niveau 2 contract: when the integration manifest declares neither a
  // `tools` block nor any `scope_catalog` catalog, there is literally
  // nothing for the agent author to pick — every tool is allowed and
  // scopes default to `auths.{key}.scopes`. Render an explicit notice
  // (rather than `return null`) so the user understands why the panel
  // is empty and can debug "the gmail integration shows nothing"
  // without grepping the codebase — typical root cause is a DB
  // manifest that predates the niveau 2 fields and needs a server
  // reboot to drift-heal.
  //
  // AFPS §4.4 wildcard exception — when the integration declares
  // `allow_undeclared_tools: true` but no declared catalog (the canonical
  // "trust the upstream MCP server" case), the wildcard toggle is still
  // meaningful and MUST surface; the early-return below would otherwise
  // hide it. We render the toggle in a minimal frame instead of the
  // noCatalog notice.
  if (!hasToolCatalog && !hasScopeCatalog && !isApiCall && !hasMultipleAuths) {
    if (wildcardEnabled) {
      return (
        <div
          className="bg-muted/30 mt-2 space-y-3 rounded-md border p-3"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="bg-background rounded-md border-l-2 border-amber-500/30 p-2">
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
    <div
      className="bg-muted/30 mt-2 space-y-3 rounded-md border p-3"
      onClick={(e) => e.stopPropagation()}
    >
      {hasMultipleAuths && (
        <div>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-semibold">
              {t("agentEditor.integrations.authKey.label")}
            </span>
            <select
              className="bg-background rounded border px-2 py-1 text-xs"
              value={entry.auth_key ?? ""}
              onChange={(e) => onAuthKeyChange(e.target.value)}
              data-testid={`integ-auth-key-${packageId}`}
            >
              <option value="">{t("agentEditor.integrations.authKey.default")}</option>
              {authEntries.map(([key, auth]) => (
                <option key={key} value={key}>
                  {authMethodLabel(key, auth)}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      {wildcardEnabled && (
        <div className="bg-background rounded-md border-l-2 border-amber-500/30 p-2">
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
      )}
      {!wildcardSelected &&
        isApiCall &&
        apiCallEntries.map((tool) => (
          <label key={tool.name} className="flex cursor-pointer items-start gap-2">
            <Checkbox
              checked={selectedTools.has(tool.name)}
              onCheckedChange={() => toggleApiCallTool(tool.name)}
              data-testid={
                apiCallEntries.length > 1
                  ? `integ-apicall-${packageId}-${tool.name}`
                  : `integ-apicall-${packageId}`
              }
            />
            <span className="flex flex-col">
              <span className="text-xs font-medium">
                {t("agentEditor.integrations.apiCall.label")}
                {apiCallEntries.length > 1 ? ` · ${tool.name}` : ""}
              </span>
              <span className="text-muted-foreground text-[11px]">
                {t("agentEditor.integrations.apiCall.description")}
              </span>
            </span>
          </label>
        ))}
      {!wildcardSelected && hasToolCatalog && (
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
            {nativeCatalog.map((entry) => {
              const requiredScopes = [
                ...new Set(Object.values(entry.policy?.required_scopes ?? {}).flat()),
              ];
              return (
                <label
                  key={entry.name}
                  className="flex cursor-pointer items-start gap-2 text-xs"
                  data-testid={`integ-tool-${packageId}-${entry.name}`}
                >
                  <Checkbox
                    checked={selectedTools.has(entry.name)}
                    onCheckedChange={() => toggleTool(entry.name)}
                    className="mt-0.5"
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className="font-mono">{entry.name}</span>
                    {entry.description && (
                      <span className="text-muted-foreground text-[11px]">{entry.description}</span>
                    )}
                    {requiredScopes.length > 0 && (
                      <span className="text-muted-foreground">
                        {t("agentEditor.integrations.tools.requires")}{" "}
                        <span className="font-mono">{requiredScopes.join(", ")}</span>
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
