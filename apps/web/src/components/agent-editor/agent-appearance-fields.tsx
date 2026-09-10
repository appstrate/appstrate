// SPDX-License-Identifier: Apache-2.0

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronsUpDown } from "lucide-react";
import { DynamicIcon } from "lucide-react/dynamic";
import { cn } from "@appstrate/ui/cn";
import { Button } from "@appstrate/ui/components/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@appstrate/ui/components/command";
import { Label } from "@appstrate/ui/components/label";
import { Popover, PopoverContent, PopoverTrigger } from "@appstrate/ui/components/popover";
import { RadioGroup, RadioGroupItem } from "@appstrate/ui/components/radio-group";
import {
  AGENT_COLOR_CATALOG,
  AGENT_ICON_NAMES,
  type AgentColorKey,
  type AgentIconName,
  isAgentColorKey,
  resolveAgentIdentity,
} from "../agent-identity-options";
import { AgentIdentityTile } from "../agent-identity";

const AGENT_UI_META_KEY = "dev.appstrate/ui";
const COLOR_KEYS = Object.keys(AGENT_COLOR_CATALOG) as AgentColorKey[];
const FEATURED_ICONS: AgentIconName[] = [
  "bot",
  "sparkles",
  "brain",
  "workflow",
  "receipt",
  "mail",
  "calendar-clock",
  "database",
  "file-text",
  "inbox",
  "newspaper",
  "chart-bar",
];
const ICON_RESULT_LIMIT = 80;

function iconLabel(name: string): string {
  return name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function manifestColor(manifest: Record<string, unknown>): string | undefined {
  const meta = asRecord(manifest._meta);
  const ui = asRecord(meta[AGENT_UI_META_KEY]);
  return typeof ui.color === "string" ? ui.color : undefined;
}

export function AgentAppearanceFields({
  manifest,
  onChange,
}: {
  manifest: Record<string, unknown>;
  onChange: (patch: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation("agents");
  const icon = typeof manifest.icon === "string" ? manifest.icon : undefined;
  const color = manifestColor(manifest);
  const resolved = resolveAgentIdentity(icon, color);
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [iconQuery, setIconQuery] = useState("");
  const customColor = resolved.customColor ?? "#2563eb";
  const iconMatches = useMemo(() => {
    const query = iconQuery.trim().toLowerCase();
    if (!query) return FEATURED_ICONS;
    return AGENT_ICON_NAMES.filter((name) => name.includes(query));
  }, [iconQuery]);
  const visibleIcons = iconMatches.slice(0, ICON_RESULT_LIMIT);

  const changeColor = (nextColor: string) => {
    const meta = { ...asRecord(manifest._meta) };
    const ui = { ...asRecord(meta[AGENT_UI_META_KEY]) };

    if (nextColor === "neutral") delete ui.color;
    else ui.color = nextColor;

    if (Object.keys(ui).length > 0) meta[AGENT_UI_META_KEY] = ui;
    else delete meta[AGENT_UI_META_KEY];

    onChange({ _meta: Object.keys(meta).length > 0 ? meta : undefined });
  };

  return (
    <div className="space-y-5">
      <div>
        <Label>{t("editor.appearancePreview")}</Label>
        <div className="border-border bg-muted/20 mt-2 flex items-center gap-3 rounded-lg border p-3">
          <AgentIdentityTile
            agentId={typeof manifest.name === "string" ? manifest.name : "agent"}
            icon={resolved.icon}
            color={resolved.color}
            className="size-11 rounded-xl"
            iconClassName="size-5"
          />
          <div>
            <p className="text-sm font-medium">
              {typeof manifest.display_name === "string" && manifest.display_name
                ? manifest.display_name
                : t("editor.appearanceAgentFallback")}
            </p>
            <p className="text-muted-foreground text-xs">{t("editor.appearanceDescription")}</p>
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <Label>{t("editor.appearanceIcon")}</Label>
        <Popover open={iconPickerOpen} onOpenChange={setIconPickerOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              role="combobox"
              aria-expanded={iconPickerOpen}
              className="w-full justify-between font-normal"
            >
              <span className="flex min-w-0 items-center gap-2">
                <DynamicIcon name={resolved.icon} className="size-4 shrink-0" />
                <span className="truncate">{iconLabel(resolved.icon)}</span>
              </span>
              <ChevronsUpDown className="text-muted-foreground size-4 shrink-0" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-[32rem] max-w-[calc(100vw-2rem)] p-0">
            <Command shouldFilter={false}>
              <CommandInput
                value={iconQuery}
                onValueChange={setIconQuery}
                placeholder={t("editor.appearanceIconSearch")}
              />
              <CommandList>
                <CommandEmpty>{t("editor.appearanceIconEmpty")}</CommandEmpty>
                <CommandGroup
                  heading={
                    iconQuery
                      ? t("editor.appearanceIconResults", { count: iconMatches.length })
                      : t("editor.appearanceIconFeatured")
                  }
                >
                  <div className="grid grid-cols-2 gap-1 p-1 sm:grid-cols-3">
                    {visibleIcons.map((name) => (
                      <CommandItem
                        key={name}
                        value={name}
                        onSelect={() => {
                          onChange({ icon: name });
                          setIconPickerOpen(false);
                        }}
                        className="min-w-0 gap-2"
                      >
                        <DynamicIcon name={name} className="size-4 shrink-0" />
                        <span className="truncate text-xs">{iconLabel(name)}</span>
                        <Check
                          className={cn(
                            "ml-auto size-3.5 shrink-0",
                            resolved.icon === name ? "opacity-100" : "opacity-0",
                          )}
                        />
                      </CommandItem>
                    ))}
                  </div>
                </CommandGroup>
                {iconMatches.length > ICON_RESULT_LIMIT && (
                  <p className="text-muted-foreground border-border border-t px-3 py-2 text-xs">
                    {t("editor.appearanceIconRefine", {
                      visible: ICON_RESULT_LIMIT,
                      count: iconMatches.length,
                    })}
                  </p>
                )}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        <p className="text-muted-foreground text-xs">
          {t("editor.appearanceIconLibrary", { count: AGENT_ICON_NAMES.length })}
        </p>
      </div>

      <div className="space-y-2">
        <Label>{t("editor.appearanceColor")}</Label>
        <RadioGroup
          value={isAgentColorKey(resolved.color) ? resolved.color : "custom"}
          onValueChange={(value) => changeColor(value === "custom" ? customColor : value)}
          className="flex flex-wrap items-center gap-2"
        >
          {COLOR_KEYS.map((key) => (
            <Label key={key} className="cursor-pointer">
              <RadioGroupItem value={key} className="peer sr-only" />
              <span
                className={cn(
                  "border-border block size-8 rounded-full border transition-shadow",
                  AGENT_COLOR_CATALOG[key],
                  "peer-data-[state=checked]:ring-ring peer-data-[state=checked]:ring-2 peer-data-[state=checked]:ring-offset-2",
                )}
                title={t(`editor.appearanceColorName.${key}`)}
              />
              <span className="sr-only">{t(`editor.appearanceColorName.${key}`)}</span>
            </Label>
          ))}
          <Label className="border-border flex h-9 cursor-pointer items-center gap-2 rounded-md border px-2.5">
            <RadioGroupItem value="custom" />
            <span className="text-sm font-normal">{t("editor.appearanceColorCustom")}</span>
            <input
              type="color"
              value={customColor}
              onChange={(event) => changeColor(event.target.value)}
              className="size-6 cursor-pointer rounded border-0 bg-transparent p-0"
              aria-label={t("editor.appearanceColorPicker")}
            />
            <code className="text-muted-foreground text-xs uppercase">{customColor}</code>
          </Label>
        </RadioGroup>
      </div>
    </div>
  );
}
