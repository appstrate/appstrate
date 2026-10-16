// SPDX-License-Identifier: Apache-2.0

import { ManualSetting } from "./settings/manual-save";
import { useTranslation } from "react-i18next";
import { Sun, Moon } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@appstrate/ui/components/dropdown-menu";
import { useTheme } from "../stores/theme-store";
import { themeOptions } from "../lib/theme";

export function ThemeToggle() {
  const { t } = useTranslation("common");
  const { theme, setTheme, resolvedTheme } = useTheme();

  const CurrentIcon = resolvedTheme === "dark" ? Moon : Sun;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="size-8">
          <CurrentIcon />
          <span className="sr-only">{t("userMenu.theme")}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <ManualSetting value={theme} onSave={async (next) => setTheme(next)}>
          {(draft, onChange) => (
            <>
              {themeOptions.map(({ value, labelKey, icon: Icon }) => (
                <DropdownMenuItem
                  key={value}
                  onSelect={(event) => {
                    event.preventDefault();
                    onChange(value);
                  }}
                >
                  <Icon className="mr-2" />
                  {t(labelKey)}
                  {draft === value && <span className="ml-auto">✓</span>}
                </DropdownMenuItem>
              ))}
            </>
          )}
        </ManualSetting>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
