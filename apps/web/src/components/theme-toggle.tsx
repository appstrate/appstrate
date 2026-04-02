// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Sun, Moon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTheme } from "../stores/theme-store";
import { themeOptions } from "../lib/theme";

export function ThemeToggle() {
  const { t } = useTranslation("common");
  const { theme, setTheme, resolvedTheme } = useTheme();

  const CurrentIcon = resolvedTheme === "dark" ? Moon : Sun;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8">
          <CurrentIcon className="h-4 w-4" />
          <span className="sr-only">{t("userMenu.theme")}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {themeOptions.map(({ value, labelKey, icon: Icon }) => (
          <DropdownMenuItem key={value} onClick={() => setTheme(value)}>
            <Icon className="mr-2 h-4 w-4" />
            {t(labelKey)}
            {theme === value && <span className="ml-auto">✓</span>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
