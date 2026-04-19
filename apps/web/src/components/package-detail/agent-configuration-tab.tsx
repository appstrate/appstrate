// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SchemaForm } from "@appstrate/ui/schema-form";
import { useSchemaFormLabels } from "../../hooks/use-schema-form-labels";
import { UPLOADS_PATH } from "../../api";
import { PROVIDER_ICONS } from "../icons";
import { findProviderByApiAndBaseUrl } from "@/lib/model-presets";
import { useModels, useAgentModel, useSetAgentModel } from "../../hooks/use-models";
import { useProxies, useAgentProxy, useSetAgentProxy } from "../../hooks/use-proxies";
import { useAppProfiles, useSetAgentAppProfile } from "../../hooks/use-connection-profiles";
import { usePackageDetail } from "../../hooks/use-packages";
import { useSaveConfig } from "../../hooks/use-mutations";
import type { JSONSchemaObject, SchemaWrapper } from "@appstrate/core/form";

// ─── Config Section ─────────────────────────────────────────────────

function ConfigSection({
  packageId,
  schema,
  isHistorical,
}: {
  packageId: string;
  schema: JSONSchemaObject;
  isHistorical?: boolean;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const { data: detail } = usePackageDetail("agent", packageId);

  const current = (detail?.config?.current ?? {}) as Record<string, unknown>;
  const mutation = useSaveConfig(detail?.id ?? "");
  const wrapper: SchemaWrapper = { schema };

  const [values, setValues] = useState<Record<string, unknown>>(() => current);
  const labels = useSchemaFormLabels();

  if (!schema?.properties || Object.keys(schema.properties).length === 0) return null;

  const handleSave = () => {
    mutation.mutate(values);
  };

  return (
    <div className="border-border bg-card space-y-3 rounded-lg border p-4">
      <h3 className="text-sm font-medium">{t("editor.configTitle")}</h3>
      <SchemaForm
        wrapper={wrapper}
        formData={values}
        uploadPath={UPLOADS_PATH}
        labels={labels}
        onChange={(e) => setValues(e.formData as Record<string, unknown>)}
      />
      <div className="flex justify-end pt-2">
        <Button onClick={handleSave} disabled={mutation.isPending || isHistorical} size="sm">
          {mutation.isPending ? "..." : t("btn.save")}
        </Button>
      </div>
    </div>
  );
}

// ─── Model Section ──────────────────────────────────────────────────

function ModelSection({ packageId }: { packageId: string }) {
  const { t } = useTranslation(["settings"]);
  const { data: orgModels } = useModels();
  const { data: agentModel } = useAgentModel(packageId);
  const setAgentModel = useSetAgentModel(packageId);
  if (!orgModels || orgModels.length === 0) return null;

  const agentModelId = agentModel?.modelId;
  const orgDefaultModel = orgModels.find((m) => m.isDefault && m.enabled);

  return (
    <div className="border-border bg-card space-y-3 rounded-lg border p-4">
      <h3 className="text-sm font-medium">{t("models.tabTitle", { ns: "settings" })}</h3>
      <Select
        value={agentModelId ?? "__inherit__"}
        onValueChange={(v) => setAgentModel.mutate(v === "__inherit__" ? null : v)}
        disabled={setAgentModel.isPending}
      >
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__inherit__">
            {orgDefaultModel
              ? t("models.agent.inherit", { ns: "settings", name: orgDefaultModel.label })
              : t("models.agent.inheritNoDefault", { ns: "settings" })}
          </SelectItem>
          {orgModels.map((m) => {
            const mp = findProviderByApiAndBaseUrl(m.api, m.baseUrl);
            const MIcon = mp ? PROVIDER_ICONS[mp.id] : undefined;
            return (
              <SelectItem key={m.id} value={m.id}>
                <span className="inline-flex items-center gap-1.5">
                  {MIcon && <MIcon className="size-3.5" />}
                  {m.label}
                </span>
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </div>
  );
}

// ─── Proxy Section ──────────────────────────────────────────────────

function ProxySection({ packageId }: { packageId: string }) {
  const { t } = useTranslation(["agents", "settings"]);
  const { data: orgProxies } = useProxies();
  const { data: agentProxy } = useAgentProxy(packageId);
  const setAgentProxy = useSetAgentProxy(packageId);
  if (!orgProxies || orgProxies.length === 0) return null;

  const agentProxyId = agentProxy?.proxyId;
  const orgDefaultProxy = orgProxies.find((p) => p.isDefault && p.enabled);

  return (
    <div className="border-border bg-card space-y-3 rounded-lg border p-4">
      <h3 className="text-sm font-medium">{t("detail.configSectionProxy")}</h3>
      <Select
        value={agentProxyId ?? "__inherit__"}
        onValueChange={(v) => setAgentProxy.mutate(v === "__inherit__" ? null : v)}
        disabled={setAgentProxy.isPending}
      >
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__inherit__">
            {orgDefaultProxy
              ? t("proxies.agent.inherit", { ns: "settings", name: orgDefaultProxy.label })
              : t("proxies.agent.inheritNoDefault", { ns: "settings" })}
          </SelectItem>
          <SelectItem value="none">{t("proxies.agent.none", { ns: "settings" })}</SelectItem>
          {orgProxies.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

// ─── Org Profile Section ───────────────────────────────────────────

function AppProfileSection({ packageId }: { packageId: string }) {
  const { t } = useTranslation(["agents", "settings"]);
  const { data: appProfiles } = useAppProfiles();
  const { data: detail } = usePackageDetail("agent", packageId);
  const setAgentAppProfile = useSetAgentAppProfile(packageId);
  if (!appProfiles || appProfiles.length === 0) return null;

  const currentAppProfileId = detail?.agentAppProfileId;

  return (
    <div className="border-border bg-card space-y-3 rounded-lg border p-4">
      <h3 className="text-sm font-medium">{t("detail.configSectionAppProfile")}</h3>
      <p className="text-muted-foreground text-xs">{t("detail.configAppProfileHint")}</p>
      <Select
        value={currentAppProfileId ?? "__none__"}
        onValueChange={(v) => setAgentAppProfile.mutate(v === "__none__" ? null : v)}
        disabled={setAgentAppProfile.isPending}
      >
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__none__">{t("detail.configAppProfileNone")}</SelectItem>
          {appProfiles.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.name}
              {p.bindingCount > 0 && (
                <span className="text-muted-foreground ml-1">
                  ({t("detail.configAppProfileBinding", { count: p.bindingCount })})
                </span>
              )}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

// ─── Main Tab ───────────────────────────────────────────────────────

export function AgentConfigurationTab({
  packageId,
  configSchemaOverride,
  isHistorical,
}: {
  packageId: string;
  configSchemaOverride?: JSONSchemaObject;
  isHistorical?: boolean;
}) {
  const { data: detail } = usePackageDetail("agent", packageId);

  const schema = isHistorical
    ? configSchemaOverride
    : (configSchemaOverride ?? detail?.config?.schema);
  const hasConfigSchema = !!(schema?.properties && Object.keys(schema.properties).length > 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <ModelSection packageId={packageId} />
        <ProxySection packageId={packageId} />
        <AppProfileSection packageId={packageId} />
      </div>
      {hasConfigSchema && schema && (
        <ConfigSection packageId={packageId} schema={schema} isHistorical={isHistorical} />
      )}
    </div>
  );
}
