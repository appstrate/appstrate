import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import CreatableSelect from "react-select/creatable";
import type { StylesConfig, MultiValue } from "react-select";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ProviderIcon } from "../provider-icon";
import { useProviders } from "../../hooks/use-providers";
import { useOrg } from "../../hooks/use-org";
import type { ProviderEntry } from "./types";
import type { AvailableScope, ProviderConfig } from "@appstrate/shared-types";
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
          <div className="text-xs text-muted-foreground font-mono">{option.value}</div>
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
  const { isOrgAdmin } = useOrg();

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
        connectionMode: "user",
      },
    ]);
  };

  const selectedIds = new Set(value.map((s) => s.id));

  return (
    <div>
      {/* Selected providers */}
      {value.length > 0 && (
        <div className="mb-4">
          <div className="text-sm font-medium text-muted-foreground mb-2">
            {t("editor.selectedServices", { count: value.length })}
          </div>
          {value.map((svc, i) => {
            const providerDef = providers?.find((p) => p.id === svc.id) as
              | ProviderConfig
              | undefined;
            return (
              <div key={i} className="border border-border rounded-lg p-3 mb-2 bg-card">
                <div className="flex items-center gap-2.5 mb-2">
                  {providerDef?.iconUrl && (
                    <ProviderIcon src={providerDef.iconUrl} className="h-6 w-6" />
                  )}
                  <div className="flex flex-col min-w-0 flex-1">
                    <strong className="text-sm">{providerDef?.displayName ?? svc.id}</strong>
                    <span className="text-xs text-muted-foreground">{svc.id}</span>
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
                    className="h-auto w-auto p-0 px-1 text-muted-foreground hover:text-destructive text-base leading-none"
                    onClick={() => remove(i)}
                  >
                    &times;
                  </Button>
                </div>
                <div className="flex flex-col gap-2.5 pl-0.5">
                  {providerDef?.authMode === "oauth2" && (
                    <div className="flex flex-col gap-1">
                      <Label className="text-xs text-muted-foreground">
                        {t("editor.scopesLabel")}
                      </Label>
                      <ScopeMultiSelect
                        scopes={svc.scopes}
                        availableScopes={providerDef?.availableScopes}
                        onChange={(scopes) => update(i, { scopes })}
                      />
                    </div>
                  )}
                  <div className="flex flex-col gap-1">
                    <Label className="text-xs text-muted-foreground">
                      {t("editor.connectionModeLabel")}
                    </Label>
                    <Select
                      value={svc.connectionMode}
                      onValueChange={(v) => update(i, { connectionMode: v as "user" | "admin" })}
                    >
                      <SelectTrigger className="h-7 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="user">{t("editor.modeUser")}</SelectItem>
                        <SelectItem value="admin">{t("editor.modeAdmin")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Available providers */}
      <div
        className={cn("text-sm font-medium text-muted-foreground mb-4", value.length > 0 && "mt-6")}
      >
        {t("editor.availableIntegrations")}
      </div>
      {isLoading ? (
        <div className="flex items-center justify-center py-6 text-sm text-muted-foreground">
          {t("loading")}
        </div>
      ) : !providers || providers.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-6 text-sm text-muted-foreground">
          {t("editor.noIntegration")}
          <div className="mt-3">
            <Link to="/providers">
              <Button variant="outline" size="sm">
                {t("editor.goToConnectors")}
              </Button>
            </Link>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {providers.map((p) => {
            const isSelected = selectedIds.has(p.id);
            return (
              <Button
                key={p.id}
                type="button"
                variant="outline"
                className={cn(
                  "h-auto flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-left transition-colors hover:border-primary hover:bg-muted/50",
                  isSelected && "border-primary bg-primary/5 opacity-60",
                )}
                onClick={() => addFromProvider(p.id)}
                disabled={isSelected}
              >
                {p.iconUrl && <ProviderIcon src={p.iconUrl} className="h-6 w-6" />}
                <div className="flex flex-col min-w-0 flex-1">
                  <span className="text-sm font-medium truncate">{p.displayName}</span>
                  <span className="text-xs text-muted-foreground">{p.id}</span>
                </div>
                {isSelected && <span className="text-success text-sm">&#10003;</span>}
              </Button>
            );
          })}
          {isOrgAdmin && (
            <Link
              to="/providers"
              className="flex items-center gap-2.5 rounded-lg border border-dashed border-border bg-card px-3 py-2.5 text-left text-muted-foreground transition-colors hover:border-primary hover:text-foreground no-underline"
            >
              <span className="text-2xl leading-none">+</span>
              <div className="flex flex-col min-w-0 flex-1">
                <span className="text-sm font-medium truncate">
                  {t("providers.addProvider", { ns: "settings" })}
                </span>
              </div>
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
