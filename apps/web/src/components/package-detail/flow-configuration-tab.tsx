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
import { InputFields } from "../input-fields";
import { PROVIDER_ICONS } from "../icons";
import { findProviderByApiAndBaseUrl } from "@/lib/model-presets";
import { useOrg } from "../../hooks/use-org";
import { useAppConfig } from "../../hooks/use-app-config";
import { useModels, useFlowModel, useSetFlowModel } from "../../hooks/use-models";
import { useProxies, useFlowProxy, useSetFlowProxy } from "../../hooks/use-proxies";
import { useOrgProfiles, useSetFlowOrgProfile } from "../../hooks/use-connection-profiles";
import { usePackageDetail } from "../../hooks/use-packages";
import { useSaveConfig } from "../../hooks/use-mutations";
import {
  initFormValues,
  buildPayload,
  type JSONSchemaObject,
  type SchemaWrapper,
} from "@appstrate/core/form";

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
  const { t } = useTranslation(["flows", "common"]);
  const { data: detail } = usePackageDetail("flow", packageId);

  const current = detail?.config?.current || {};
  const mutation = useSaveConfig(detail?.id ?? "");
  const wrapper: SchemaWrapper = { schema };

  const [values, setValues] = useState<Record<string, unknown>>(() =>
    initFormValues(schema, current),
  );

  if (!schema?.properties || Object.keys(schema.properties).length === 0) return null;

  const handleSave = () => {
    mutation.mutate(buildPayload(schema, values));
  };

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3">
      <h3 className="text-sm font-medium">{t("editor.configTitle")}</h3>
      <InputFields
        schema={wrapper}
        values={values}
        onChange={(key, v) => setValues((prev) => ({ ...prev, [key]: v }))}
        idPrefix="config"
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
  const { features } = useAppConfig();
  const { data: orgModels } = useModels();
  const { data: flowModel } = useFlowModel(packageId);
  const setFlowModel = useSetFlowModel(packageId);
  const { isOrgAdmin } = useOrg();

  if (!features.models || !isOrgAdmin || !orgModels || orgModels.length === 0) return null;

  const flowModelId = flowModel?.modelId;
  const orgDefaultModel = orgModels.find((m) => m.isDefault && m.enabled);

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3">
      <h3 className="text-sm font-medium">{t("models.tabTitle", { ns: "settings" })}</h3>
      <Select
        value={flowModelId ?? "__inherit__"}
        onValueChange={(v) => setFlowModel.mutate(v === "__inherit__" ? null : v)}
        disabled={setFlowModel.isPending}
      >
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__inherit__">
            {orgDefaultModel
              ? t("models.flow.inherit", { ns: "settings", name: orgDefaultModel.label })
              : t("models.flow.inheritNoDefault", { ns: "settings" })}
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
  const { t } = useTranslation(["flows", "settings"]);
  const { data: orgProxies } = useProxies();
  const { data: flowProxy } = useFlowProxy(packageId);
  const setFlowProxy = useSetFlowProxy(packageId);
  const { isOrgAdmin } = useOrg();

  if (!isOrgAdmin || !orgProxies || orgProxies.length === 0) return null;

  const flowProxyId = flowProxy?.proxyId;
  const orgDefaultProxy = orgProxies.find((p) => p.isDefault && p.enabled);

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3">
      <h3 className="text-sm font-medium">{t("detail.configSectionProxy")}</h3>
      <Select
        value={flowProxyId ?? "__inherit__"}
        onValueChange={(v) => setFlowProxy.mutate(v === "__inherit__" ? null : v)}
        disabled={setFlowProxy.isPending}
      >
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__inherit__">
            {orgDefaultProxy
              ? t("proxies.flow.inherit", { ns: "settings", name: orgDefaultProxy.label })
              : t("proxies.flow.inheritNoDefault", { ns: "settings" })}
          </SelectItem>
          <SelectItem value="none">{t("proxies.flow.none", { ns: "settings" })}</SelectItem>
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

function OrgProfileSection({ packageId }: { packageId: string }) {
  const { t } = useTranslation(["flows", "settings"]);
  const { data: orgProfiles } = useOrgProfiles();
  const { data: detail } = usePackageDetail("flow", packageId);
  const setFlowOrgProfile = useSetFlowOrgProfile(packageId);
  const { isOrgAdmin } = useOrg();

  if (!isOrgAdmin || !orgProfiles || orgProfiles.length === 0) return null;

  const currentOrgProfileId = detail?.flowOrgProfileId;

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3">
      <h3 className="text-sm font-medium">
        {t("detail.configSectionOrgProfile", { defaultValue: "Organization profile" })}
      </h3>
      <p className="text-xs text-muted-foreground">
        {t("detail.configOrgProfileHint", {
          defaultValue:
            "Select an organization connection profile. Providers bound in this profile will be shared with all users.",
        })}
      </p>
      <Select
        value={currentOrgProfileId ?? "__none__"}
        onValueChange={(v) => setFlowOrgProfile.mutate(v === "__none__" ? null : v)}
        disabled={setFlowOrgProfile.isPending}
      >
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__none__">
            {t("detail.configOrgProfileNone", {
              defaultValue: "None — all connections managed by users",
            })}
          </SelectItem>
          {orgProfiles.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.name}
              {p.bindingCount > 0 && (
                <span className="text-muted-foreground ml-1">
                  ({p.bindingCount} {p.bindingCount === 1 ? "binding" : "bindings"})
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

export function FlowConfigurationTab({
  packageId,
  configSchemaOverride,
  isHistorical,
}: {
  packageId: string;
  configSchemaOverride?: JSONSchemaObject;
  isHistorical?: boolean;
}) {
  const { data: detail } = usePackageDetail("flow", packageId);

  const schema = isHistorical
    ? configSchemaOverride
    : (configSchemaOverride ?? detail?.config?.schema);
  const hasConfigSchema = !!(schema?.properties && Object.keys(schema.properties).length > 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <ModelSection packageId={packageId} />
        <ProxySection packageId={packageId} />
        <OrgProfileSection packageId={packageId} />
      </div>
      {hasConfigSchema && schema && (
        <ConfigSection packageId={packageId} schema={schema} isHistorical={isHistorical} />
      )}
    </div>
  );
}
