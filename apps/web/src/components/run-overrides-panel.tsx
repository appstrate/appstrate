// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Label } from "@appstrate/ui/components/label";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { isQueryInFlight } from "../lib/query-state";
import { SelectItem } from "@appstrate/ui/components/select";
import { OptionSelect } from "@/components/app-ui/option-select";
import { useModels } from "../hooks/use-models";
import { isModelSelectable } from "@appstrate/core/model-selectable";
import { ModelSelect } from "./model-select";
import { useProxies } from "../hooks/use-proxies";
import { useIntegrationDetail } from "../hooks/use-integrations";
import { useIntegrationName } from "../hooks/use-integration-name";
import {
  connectableAuthKeysForAgent,
  resolveEffectiveToolSelection,
} from "@appstrate/core/integration";
import { IntegrationConnectionPicker } from "./integration-connect/integration-connection-picker";
import type { ConnectionSet } from "../lib/connection-set";
import { inheritedEntry } from "../lib/run-launch";
import type { RunOverridesValue } from "../lib/schedule-payload";
import { ModelGenerationFields } from "./model-generation-fields";
import { GenerationSettingRows } from "./model-generation-rows";
import { SettingRow } from "./settings/setting-row";
import {
  reconcileModelGenerationSettings,
  type ModelGenerationSettings,
} from "@appstrate/core/model-generation";

const INHERIT = "__inherit__";
// Wire value the server recognizes as "no proxy" (distinct from INHERIT =
// "use the org default"). Emitting it verbatim — rather than an internal
// `__none__` sentinel each caller has to translate — means both the run
// launcher and the schedule form send the right value, so a scheduled run
// with "None" selected is not silently routed through the org-default
// proxy.
const NONE = "none";

interface AgentIntegrationRef {
  id: string;
  tools?: string[] | "*";
  scopes?: string[];
}

interface RunOverridesPanelProps {
  packageId: string;
  /** Persisted model id (or null = inherit org default). */
  persistedModelId: string | null;
  /** Persisted generation defaults shown as the inherit baseline. */
  persistedGenerationConfig: ModelGenerationSettings | null;
  /** Persisted proxy id (or null = inherit org default). */
  persistedProxyId: string | null;
  /**
   * Agent's declared integration dependencies — drives the
   * connection-overrides pickers. Pass an empty array to hide the section
   * (e.g. for agents without integrations). The caller is responsible
   * for reading `dependencies.integrations` off the agent manifest.
   */
  agentIntegrations?: AgentIntegrationRef[];
  /** Current value (controlled). */
  value: RunOverridesValue;
  /** A model, generation or proxy change: the whole next value. */
  onChange: (next: RunOverridesValue) => void;
  /**
   * One integration's connection pick; the connection pickers appear with it (and
   * `agentIntegrations`). A picker calls it once its connect popup settles, long after the
   * render that built it: the parent applies it to the value it holds then.
   */
  onConnectionPick?: (integrationId: string, connectionIds: ConnectionSet) => void;
  /**
   * Version selector forwarded to the integration connection pickers so
   * their per-integration readiness verdict judges the definition that runs.
   */
  version: string;
  /**
   * `launch` (the run modal): labelled fields, temperature and reasoning as
   * sliders. `settings` (a schedule's Exécution): the settings rows and selects
   * of the agent's own Modèle and Proxy sections.
   */
  layout?: "launch" | "settings";
  /**
   * For a schedule: it spends organization credentials only, so a model each
   * member pays for themselves cannot be picked, and nobody's credential is named.
   * The connection hint then speaks of every fire instead of this run.
   */
  scheduled?: boolean;
  /** Set when the form sits in a URL-param modal: a picker's way out leaves that modal. */
  onLeave?: (to: string) => void;
}

/** One override: a labelled field in a launch form, a settings row elsewhere. */
function OverrideRow({
  layout,
  label,
  description,
  children,
}: {
  layout: "launch" | "settings";
  label: string;
  description: string;
  children: ReactNode;
}) {
  if (layout === "settings") {
    return (
      <SettingRow label={label} description={description}>
        {children}
      </SettingRow>
    );
  }
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

/**
 * Override editor for the agent's resolution defaults — model, proxy and
 * integration connections. Shared by the schedule editor and the run launcher,
 * where these three carry identical semantics (no pick = the agent default).
 * The value is a delta: each field is present only when it differs from the
 * persisted default, so the caller never re-implements diff detection.
 *
 * Agent parameters are deliberately NOT here — they are the agent's single
 * `input` schema, rendered by {@link AgentInputForm} at the top of every launch
 * surface, not an override layer.
 *
 * Version is deliberately NOT here either — its semantics are context-specific
 * (a schedule inherits/pins; a run defaults to `draft` and applies every pick),
 * so each caller composes {@link AgentVersionField} itself.
 */
export function RunOverridesPanel({
  packageId,
  persistedModelId,
  persistedGenerationConfig,
  persistedProxyId,
  agentIntegrations,
  value,
  onChange,
  onConnectionPick,
  version,
  layout = "launch",
  scheduled = false,
  onLeave,
}: RunOverridesPanelProps) {
  const { t } = useTranslation(["agents", "settings"]);
  const modelsQuery = useModels();
  const proxiesQuery = useProxies();
  const { data: orgModels } = modelsQuery;
  const { data: orgProxies } = proxiesQuery;
  // A row stands in as a skeleton until its list lands, and is dropped only if it lands empty.
  const modelsPending = isQueryInFlight(modelsQuery);
  const proxiesPending = isQueryInFlight(proxiesQuery);

  // The inherited row stays visible even when the default is unavailable, so
  // users can still clear an override and see which model will be resolved.
  const orgDefaultModel = orgModels?.find((model) => model.is_default);
  const orgDefaultProxy = orgProxies?.find((proxy) => proxy.is_default && proxy.enabled);
  // "Inherit" names what applies with no override.
  const inheritedModel = inheritedEntry(
    orgModels,
    persistedModelId,
    orgDefaultModel,
    isModelSelectable,
  );
  const inheritedProxy = inheritedEntry(
    orgProxies,
    persistedProxyId,
    orgDefaultProxy,
    (proxy) => proxy.enabled,
  );
  // A schedule keeps an override whose entry was deleted: show it, not a blank select.
  const goneProxyOverride =
    value.proxy_id_override &&
    value.proxy_id_override !== NONE &&
    !orgProxies?.some((p) => p.id === value.proxy_id_override)
      ? value.proxy_id_override
      : null;

  const setModel = (next: string | null) => {
    const nextModel =
      next === null ? inheritedModel : orgModels?.find((model) => model.id === next);
    const generation = reconcileModelGenerationSettings(
      value.generation_config_override ?? {},
      nextModel?.generation,
    );
    const nextValue = { ...value };

    if (Object.keys(generation).length === 0) {
      delete nextValue.generation_config_override;
    } else {
      nextValue.generation_config_override = generation;
    }

    if (next === null || next === persistedModelId) {
      delete nextValue.model_id_override;
    } else {
      nextValue.model_id_override = next;
    }
    onChange(nextValue);
  };

  const setProxy = (next: string) => {
    if (next === INHERIT || next === (persistedProxyId ?? INHERIT)) {
      const { proxy_id_override: _omit, ...rest } = value;
      void _omit;
      onChange(rest);
    } else {
      onChange({ ...value, proxy_id_override: next });
    }
  };

  const setGeneration = (generation: ModelGenerationSettings) => {
    if (Object.keys(generation).length === 0) {
      const { generation_config_override: _omit, ...rest } = value;
      void _omit;
      onChange(rest);
    } else {
      onChange({ ...value, generation_config_override: generation });
    }
  };

  const selectedModel =
    orgModels?.find((model) => model.id === value.model_id_override) ?? inheritedModel;
  const proxySelectValue = value.proxy_id_override ?? INHERIT;

  return (
    <div className={layout === "launch" ? "space-y-4" : undefined}>
      {(modelsPending || (orgModels && orgModels.length > 0)) && (
        <OverrideRow
          layout={layout}
          label={
            layout === "settings"
              ? t("detail.configuration.modelChoice", { ns: "agents" })
              : t("models.tabTitle", { ns: "settings" })
          }
          description={t("schedule.settings.modelHint", { ns: "agents" })}
        >
          {modelsPending || !orgModels ? (
            <Skeleton className="h-9 w-full" />
          ) : (
            <ModelSelect
              models={orgModels}
              value={value.model_id_override ?? null}
              onChange={setModel}
              scheduled={scheduled}
              // "Inherit" stays selectable even when the default is dead: it is the absence of an
              // override, so disabling it would trap a user who wants to clear one.
              inherit={{
                label: inheritedModel
                  ? t("run.overrides.modelInheritWithDefault", {
                      ns: "agents",
                      name: inheritedModel.label,
                    })
                  : t("run.overrides.modelInherit", { ns: "agents" }),
                modelId: inheritedModel?.id ?? null,
              }}
            />
          )}
        </OverrideRow>
      )}

      {orgModels && orgModels.length > 0 && layout === "settings" && (
        <GenerationSettingRows
          model={selectedModel}
          generation={value.generation_config_override ?? {}}
          inheritLabels={{
            ...(persistedGenerationConfig?.temperature != null
              ? { temperature: t("schedule.settings.inheritAgent", { ns: "agents" }) }
              : {}),
            ...(persistedGenerationConfig?.reasoning_level
              ? { reasoning: t("schedule.settings.inheritAgent", { ns: "agents" }) }
              : {}),
          }}
          onChange={setGeneration}
        />
      )}

      {orgModels && orgModels.length > 0 && layout === "launch" && (
        <ModelGenerationFields
          value={value.generation_config_override ?? {}}
          model={selectedModel}
          onChange={setGeneration}
        />
      )}

      {layout === "launch" &&
        persistedGenerationConfig &&
        Object.keys(persistedGenerationConfig).length > 0 && (
          <p className="text-muted-foreground text-xs">
            {t("run.overrides.generationInheritHint", { ns: "agents" })}
          </p>
        )}

      {(proxiesPending || (orgProxies && orgProxies.length > 0)) && (
        <OverrideRow
          layout={layout}
          label={t("detail.configSectionProxy", { ns: "agents" })}
          description={t("schedule.settings.proxyHint", { ns: "agents" })}
        >
          {proxiesPending || !orgProxies ? (
            <Skeleton className="h-9 w-full" />
          ) : (
            <OptionSelect
              value={proxySelectValue}
              onValueChange={setProxy}
              leading={
                <SelectItem value={INHERIT}>
                  {persistedProxyId === NONE
                    ? t("run.overrides.proxyInheritWithDefault", {
                        ns: "agents",
                        name: t("run.overrides.proxyNone", { ns: "agents" }),
                      })
                    : inheritedProxy
                      ? t("run.overrides.proxyInheritWithDefault", {
                          ns: "agents",
                          name: inheritedProxy.label,
                        })
                      : t("run.overrides.proxyInherit", { ns: "agents" })}
                </SelectItem>
              }
              options={[
                { value: NONE, label: t("run.overrides.proxyNone", { ns: "agents" }) },
                ...(goneProxyOverride
                  ? [
                      {
                        value: goneProxyOverride,
                        label: t("run.overrides.proxyGone", { ns: "agents" }),
                        disabled: true,
                      },
                    ]
                  : []),
                ...orgProxies.map((p) => ({ value: p.id, label: p.label })),
              ]}
            />
          )}
        </OverrideRow>
      )}

      {agentIntegrations && agentIntegrations.length > 0 && onConnectionPick && (
        <ConnectionOverridesSection
          agentPackageId={packageId}
          integrations={agentIntegrations}
          version={version}
          scheduled={scheduled}
          value={value.connection_overrides ?? {}}
          onChange={onConnectionPick}
          onLeave={onLeave}
        />
      )}
    </div>
  );
}

/**
 * Per-integration picker section that drives `value.connection_overrides`.
 * Renders the shared `IntegrationConnectionPicker` (one dropdown per
 * integration) in `override` mode: validating a set writes it into the
 * `connection_overrides` map, the reset entry clears the key, "No connection"
 * writes `[]`. The map is the launch override (below admin pins, above member
 * pins) of the form that holds it: one run's, or a schedule's on every fire.
 *
 * Identical UX to the agent page's connection picker — same candidate
 * list, scope/lock verdicts and inline connect flow — only the
 * persistence target differs (transient form value vs. member pin).
 */
function ConnectionOverridesSection({
  agentPackageId,
  integrations,
  version,
  scheduled,
  value,
  onChange,
  onLeave,
}: {
  agentPackageId: string;
  integrations: AgentIntegrationRef[];
  version: string;
  scheduled: boolean;
  value: Record<string, string[]>;
  onChange: (integrationId: string, connectionIds: ConnectionSet) => void;
  onLeave?: (to: string) => void;
}) {
  const { t } = useTranslation(["agents"]);
  return (
    <div className="space-y-2">
      <Label>{t("connectionOverrides.label")}</Label>
      <p className="text-muted-foreground text-xs">
        {scheduled ? t("schedule.connectionOverrides.hint") : t("run.overrides.connectionHint")}
      </p>
      <div className="border-border bg-card space-y-3 rounded-md border p-3">
        {integrations.map((integ) => (
          <IntegrationOverrideRow
            key={integ.id}
            agentPackageId={agentPackageId}
            integration={integ}
            version={version}
            value={value[integ.id] ?? null}
            onChange={(connIds) => onChange(integ.id, connIds)}
            onLeave={onLeave}
          />
        ))}
      </div>
    </div>
  );
}

function IntegrationOverrideRow({
  agentPackageId,
  integration,
  version,
  value,
  onChange,
  onLeave,
}: {
  agentPackageId: string;
  integration: AgentIntegrationRef;
  version: string;
  /** This form's pick: `null` = none (the row shows what the agent binds), `[]` = no connection. */
  value: ConnectionSet;
  onChange: (next: ConnectionSet) => void;
  onLeave?: (to: string) => void;
}) {
  const detailQuery = useIntegrationDetail(integration.id);
  const { data: detail } = detailQuery;
  const displayName = useIntegrationName(integration.id);

  // Gate the row on whether the agent can connect this integration at all
  // (declared auth the actor can start a flow on, given its EFFECTIVE tool
  // selection: an agent writing no `tools` inherits `default_tools`).
  // Mirrors the run-time `integration_not_active`/no-auth gates so neither
  // form offers an override for an unconnectable integration.
  if (!detail) {
    if (!isQueryInFlight(detailQuery)) return null;
    return (
      <div className="space-y-1.5">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-8 w-full" />
      </div>
    );
  }
  const effectiveTools = resolveEffectiveToolSelection(integration.tools, detail.manifest);
  if (connectableAuthKeysForAgent(detail.manifest, effectiveTools).length === 0) return null;

  return (
    <div className="space-y-1.5" data-testid={`conn-override-row-${integration.id}`}>
      <div className="text-xs font-medium">{displayName}</div>
      <IntegrationConnectionPicker
        integration={integration}
        agentPackageId={agentPackageId}
        persistence={{ mode: "override", value, onChange }}
        version={version}
        onLeave={onLeave}
      />
    </div>
  );
}
