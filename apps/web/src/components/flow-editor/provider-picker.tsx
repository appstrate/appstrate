// SPDX-License-Identifier: Apache-2.0

import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import CreatableSelect from "react-select/creatable";
import type { StylesConfig, MultiValue } from "react-select";
import { Link } from "react-router-dom";
import { ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ProviderIcon } from "../provider-icon";
import { ProviderConfigBadge } from "../provider-config-badge";
import { ProviderCredentialsModal } from "../provider-credentials-modal";
import { Modal } from "../modal";
import { useProviders } from "../../hooks/use-providers";
import type { ProviderEntry } from "./types";
import type { ProviderConfig } from "@appstrate/shared-types";
import type { AvailableScope } from "@appstrate/core/validation";
import { VersionSelect } from "./resource-section";

interface ProviderPickerProps {
  value: ProviderEntry[];
  onChange: (value: ProviderEntry[]) => void;
}

interface ScopeOption {
  value: string;
  label: string;
}

const scopeSelectStyles: StylesConfig<ScopeOption, true> = {
  control: (base, state) => ({
    ...base,
    background: "var(--color-background)",
    borderColor: state.isFocused ? "var(--color-primary)" : "var(--color-border)",
    borderRadius: "4px",
    minHeight: "34px",
    fontSize: "0.8rem",
    boxShadow: "none",
    "&:hover": { borderColor: "var(--color-muted-foreground)" },
  }),
  menu: (base) => ({
    ...base,
    background: "var(--color-card)",
    border: "1px solid var(--color-border)",
    borderRadius: "6px",
    zIndex: 20,
    overflow: "hidden",
  }),
  menuList: (base) => ({
    ...base,
    padding: "0.25rem",
  }),
  option: (base, state) => ({
    ...base,
    background: state.isFocused ? "var(--color-accent)" : "transparent",
    color: state.isSelected ? "var(--color-primary)" : "var(--color-foreground)",
    fontSize: "0.8rem",
    padding: "0.375rem 0.5rem",
    borderRadius: "4px",
    cursor: "pointer",
    "&:active": { background: "var(--color-accent)" },
  }),
  multiValue: (base) => ({
    ...base,
    background: "var(--color-secondary)",
    border: "1px solid var(--color-border)",
    borderRadius: "4px",
  }),
  multiValueLabel: (base) => ({
    ...base,
    color: "var(--color-foreground)",
    fontSize: "0.75rem",
    padding: "0.1rem 0.375rem",
  }),
  multiValueRemove: (base) => ({
    ...base,
    color: "var(--color-muted-foreground)",
    "&:hover": {
      background: "color-mix(in oklab, var(--color-destructive) 15%, transparent)",
      color: "var(--color-destructive)",
    },
  }),
  input: (base) => ({
    ...base,
    color: "var(--color-foreground)",
    fontSize: "0.8rem",
  }),
  placeholder: (base) => ({
    ...base,
    color: "var(--color-muted-foreground)",
    fontSize: "0.8rem",
  }),
  noOptionsMessage: (base) => ({
    ...base,
    color: "var(--color-muted-foreground)",
    fontSize: "0.8rem",
  }),
  clearIndicator: (base) => ({
    ...base,
    color: "var(--color-muted-foreground)",
    padding: "0 4px",
    "&:hover": { color: "var(--color-foreground)" },
  }),
  dropdownIndicator: (base) => ({
    ...base,
    color: "var(--color-muted-foreground)",
    padding: "0 4px",
    "&:hover": { color: "var(--color-foreground)" },
  }),
  indicatorSeparator: (base) => ({
    ...base,
    backgroundColor: "var(--color-border)",
  }),
  valueContainer: (base) => ({
    ...base,
    padding: "0 6px",
    gap: "2px",
  }),
};

function ScopeMultiSelect({
  scopes,
  availableScopes,
  onChange,
}: {
  scopes: string[];
  availableScopes?: AvailableScope[];
  onChange: (scopes: string[]) => void;
}) {
  const { t } = useTranslation("flows");

  const options: ScopeOption[] = useMemo(
    () =>
      (availableScopes ?? []).map((s) => ({
        value: s.value,
        label: s.label,
      })),
    [availableScopes],
  );

  const selectedOptions: ScopeOption[] = useMemo(() => {
    const knownMap = new Map(options.map((o) => [o.value, o]));
    return scopes.map((v) => knownMap.get(v) ?? { value: v, label: v });
  }, [scopes, options]);

  const handleChange = (newValue: MultiValue<ScopeOption>) => {
    onChange(newValue.map((o) => o.value));
  };

  const formatOptionLabel = (option: ScopeOption, ctx: { context: string }) => {
    if (ctx.context === "menu") {
      return (
        <div>
          <div className="text-sm">{option.label}</div>
          <div className="text-muted-foreground font-mono text-xs">{option.value}</div>
        </div>
      );
    }
    return option.label;
  };

  return (
    <CreatableSelect<ScopeOption, true>
      isMulti
      options={options}
      value={selectedOptions}
      onChange={handleChange}
      formatOptionLabel={formatOptionLabel}
      formatCreateLabel={(input) => input}
      placeholder={t("editor.customScopePlaceholder")}
      noOptionsMessage={() => null}
      styles={scopeSelectStyles}
      isClearable
      menuPlacement="auto"
    />
  );
}

export function ProviderPicker({ value, onChange }: ProviderPickerProps) {
  const { t } = useTranslation(["flows", "common", "settings"]);
  const { data: providersData, isLoading } = useProviders();
  const providers = providersData?.providers;
  const [configurePickerOpen, setConfigurePickerOpen] = useState(false);
  const [configureProvider, setConfigureProvider] = useState<ProviderConfig | null>(null);

  const update = (index: number, patch: Partial<ProviderEntry>) => {
    const next = value.map((s, i) => (i === index ? { ...s, ...patch } : s));
    onChange(next);
  };

  const remove = (index: number) => {
    onChange(value.filter((_, i) => i !== index));
  };

  const addFromProvider = (providerId: string) => {
    const alreadySelected = value.some((s) => s.id === providerId);
    if (alreadySelected) return;
    const provider = providers?.find((p) => p.id === providerId);
    onChange([
      ...value,
      {
        id: providerId,
        version: provider?.version ?? "*",
        scopes: [],
      },
    ]);
  };

  const selectedIds = new Set(value.map((s) => s.id));

  // Only show enabled (configured + active) providers in the available grid
  const enabledProviders = useMemo(() => (providers ?? []).filter((p) => p.enabled), [providers]);

  const allProviders = providers ?? [];

  return (
    <div>
      {/* Selected providers */}
      {value.length > 0 && (
        <div className="mb-4">
          <div className="text-muted-foreground mb-2 text-sm font-medium">
            {t("editor.selectedServices", { count: value.length })}
          </div>
          {value.map((svc, i) => {
            const providerDef = providers?.find((p) => p.id === svc.id) as
              | ProviderConfig
              | undefined;
            return (
              <div key={svc.id} className="border-border bg-card mb-2 rounded-lg border p-3">
                <div className="mb-2 flex items-center gap-2.5">
                  {providerDef?.iconUrl && (
                    <ProviderIcon src={providerDef.iconUrl} className="h-6 w-6" />
                  )}
                  <div className="flex min-w-0 flex-1 flex-col">
                    <strong className="flex items-center gap-1.5 text-sm">
                      {providerDef?.displayName ?? svc.id}
                      {providerDef?.source === "built-in" && (
                        <ShieldCheck className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
                      )}
                    </strong>
                    <span className="text-muted-foreground text-xs">{svc.id}</span>
                  </div>
                  <VersionSelect
                    type="provider"
                    packageId={svc.id}
                    value={svc.version}
                    onChange={(v) => update(i, { version: v })}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground hover:text-destructive h-auto w-auto p-0 px-1 text-base leading-none"
                    onClick={() => remove(i)}
                  >
                    &times;
                  </Button>
                </div>
                <div className="flex flex-col gap-2.5 pl-0.5">
                  {providerDef?.authMode === "oauth2" && (
                    <div className="flex flex-col gap-1">
                      <Label className="text-muted-foreground text-xs">
                        {t("editor.scopesLabel")}
                      </Label>
                      <ScopeMultiSelect
                        scopes={svc.scopes}
                        availableScopes={providerDef?.availableScopes}
                        onChange={(scopes) => update(i, { scopes })}
                      />
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Available providers (only enabled ones) */}
      <div
        className={cn("text-muted-foreground mb-4 text-sm font-medium", value.length > 0 && "mt-6")}
      >
        {t("editor.availableIntegrations")}
      </div>
      {isLoading ? (
        <div className="text-muted-foreground flex items-center justify-center py-6 text-sm">
          {t("loading")}
        </div>
      ) : enabledProviders.length === 0 ? (
        <div className="text-muted-foreground flex flex-col items-center justify-center py-6 text-sm">
          {t("editor.noIntegration")}
          <div className="mt-3">
            <Button variant="outline" size="sm" onClick={() => setConfigurePickerOpen(true)}>
              {t("providers.addProvider", { ns: "settings" })}
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {enabledProviders.map((p) => {
            const isSelected = selectedIds.has(p.id);
            return (
              <Button
                key={p.id}
                type="button"
                variant="outline"
                className={cn(
                  "hover:border-primary hover:bg-muted/50 flex h-auto items-center gap-2.5 rounded-lg px-3 py-2.5 text-left transition-colors",
                  isSelected && "border-primary bg-primary/5 opacity-60",
                )}
                onClick={() => addFromProvider(p.id)}
                disabled={isSelected}
              >
                {p.iconUrl && <ProviderIcon src={p.iconUrl} className="h-6 w-6" />}
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-center gap-1.5 truncate text-sm font-medium">
                    {p.displayName}
                    {p.source === "built-in" && (
                      <ShieldCheck className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
                    )}
                  </span>
                  <span className="text-muted-foreground text-xs">{p.id}</span>
                </div>
                {isSelected && <span className="text-success text-sm">&#10003;</span>}
              </Button>
            );
          })}
          <button
            type="button"
            className="border-border bg-card text-muted-foreground hover:border-primary hover:text-foreground flex items-center gap-2.5 rounded-lg border border-dashed px-3 py-2.5 text-left transition-colors"
            onClick={() => setConfigurePickerOpen(true)}
          >
            <span className="text-2xl leading-none">+</span>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm font-medium">
                {t("providers.addProvider", { ns: "settings" })}
              </span>
            </div>
          </button>
        </div>
      )}

      {/* Configure provider picker modal (same as providers page) */}
      <Modal
        open={configurePickerOpen}
        onClose={() => setConfigurePickerOpen(false)}
        title={t("providers.configureProvider", { ns: "settings" })}
      >
        <p className="text-muted-foreground mb-4 text-sm">
          {t("providers.selectProvider", { ns: "settings" })}
        </p>
        {allProviders.length === 0 ? (
          <p className="text-muted-foreground py-4 text-center text-sm">
            {t("providers.allConfigured", { ns: "settings" })}
          </p>
        ) : (
          <div className="space-y-1">
            {allProviders.map((p) => (
              <button
                key={p.id}
                type="button"
                className="hover:bg-muted/50 flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors"
                onClick={() => {
                  setConfigurePickerOpen(false);
                  setConfigureProvider(p);
                }}
              >
                {p.iconUrl ? (
                  <ProviderIcon src={p.iconUrl} className="h-6 w-6" />
                ) : (
                  <div className="bg-muted text-muted-foreground flex h-6 w-6 items-center justify-center rounded text-xs font-medium">
                    {p.displayName.charAt(0).toUpperCase()}
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 text-sm font-medium">
                    {p.displayName}
                    {p.source === "built-in" && (
                      <ShieldCheck className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
                    )}
                  </span>
                </div>
                <ProviderConfigBadge enabled={p.enabled} />
              </button>
            ))}
          </div>
        )}
        <div className="border-border mt-4 border-t pt-3">
          <Link
            to="/providers/new"
            className="text-muted-foreground hover:text-foreground hover:bg-muted/50 flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium no-underline transition-colors"
          >
            <span className="text-lg leading-none">+</span>
            {t("providers.newProvider", { ns: "settings" })}
          </Link>
        </div>
      </Modal>

      {/* Provider credentials configuration modal */}
      {configureProvider && (
        <ProviderCredentialsModal
          provider={configureProvider}
          callbackUrl={providersData?.callbackUrl}
          onClose={() => setConfigureProvider(null)}
        />
      )}
    </div>
  );
}
