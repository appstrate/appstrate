// SPDX-License-Identifier: Apache-2.0

import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Check, LogOut, Settings, FileText, Palette } from "lucide-react";
import { useAuth } from "../hooks/use-auth";
import { useTheme } from "../stores/theme-store";
import { themeOptions } from "../lib/theme";
import { Avatar, AvatarFallback } from "@appstrate/ui/components/avatar";
import { Button } from "@appstrate/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@appstrate/ui/components/dropdown-menu";

function getInitials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((s) => s[0] ?? "")
    .join("")
    .toUpperCase();
}

export function NavUser() {
  const { t } = useTranslation();
  const { user, profile, logout } = useAuth();
  const { theme, setTheme } = useTheme();
  const queryClient = useQueryClient();

  if (!user) return null;

  const displayName = profile?.displayName || user.email || "";
  const initials = getInitials(displayName);

  const handleLogout = async () => {
    await logout();
    queryClient.clear();
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("userMenu.ariaLabel")}
          className="rounded-full"
        >
          <Avatar className="size-8 rounded-full">
            <AvatarFallback className="bg-sidebar-primary text-sidebar-primary-foreground rounded-full text-sm font-medium">
              {initials}
            </AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="min-w-56 rounded-lg" side="bottom" align="end" sideOffset={4}>
        <DropdownMenuLabel className="p-0 font-normal">
          <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
            <Avatar className="size-8 rounded-lg">
              <AvatarFallback className="bg-sidebar-primary text-sidebar-primary-foreground rounded-lg text-sm font-medium">
                {initials}
              </AvatarFallback>
            </Avatar>
            <div className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-semibold">{displayName}</span>
              <span className="truncate text-xs">{user.email}</span>
            </div>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/preferences" className="flex items-center gap-2">
            <Settings size={14} />
            {t("userMenu.preferences")}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Palette size={14} />
            {t("userMenu.theme")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {themeOptions.map(({ value, labelKey, icon: Icon }) => (
              <DropdownMenuItem
                key={value}
                onSelect={() => setTheme(value)}
                className="flex items-center gap-2"
              >
                <Icon size={14} />
                {t(labelKey)}
                {theme === value && (
                  <Check size={14} strokeWidth={2.5} className="text-primary ml-auto shrink-0" />
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem asChild>
          <a
            href="/api/docs"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2"
          >
            <FileText size={14} />
            {t("userMenu.apiDocs")}
          </a>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void handleLogout()} className="flex items-center gap-2">
          <LogOut size={14} />
          {t("userMenu.logout")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
