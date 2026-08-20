// SPDX-License-Identifier: Apache-2.0

import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { BookOpen, Check, FileText, LifeBuoy, LogOut, Palette, Settings } from "lucide-react";
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

interface NavUserProps {
  /**
   * Drop every entry that needs an organization to be resolvable.
   *
   * `/preferences` lives under `MainLayout`, behind `OrgGate`: a user with no
   * org who follows it is bounced straight back to `/onboarding/create`. The
   * onboarding flow therefore mounts this menu with only the identity header,
   * the theme switcher and logout — all org-independent.
   */
  minimal?: boolean;
}

export function NavUser({ minimal = false }: NavUserProps) {
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
            <AvatarFallback className="bg-spark text-spark-foreground rounded-full text-sm font-medium">
              {initials}
            </AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="min-w-56 rounded-lg" side="bottom" align="end" sideOffset={4}>
        <DropdownMenuLabel className="p-0 font-normal">
          <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
            <Avatar className="size-8 rounded-lg">
              <AvatarFallback className="bg-spark text-spark-foreground rounded-lg text-sm font-medium">
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
        {!minimal && (
          <DropdownMenuItem asChild>
            <Link to="/preferences" className="flex items-center gap-2">
              <Settings size={14} />
              {t("userMenu.preferences")}
            </Link>
          </DropdownMenuItem>
        )}
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
        {/* Documentation and support live here as well as in the product
            switcher. The duplication is deliberate: this menu is where people
            look for help by habit, and a second door onto the docs costs less
            than a first door nobody finds. */}
        <DropdownMenuItem asChild>
          <a
            href="https://docs.appstrate.dev"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2"
          >
            <BookOpen size={14} />
            {t("userMenu.documentation")}
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a
            href="https://discord.gg/5Js2CKWNnh"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2"
          >
            <LifeBuoy size={14} />
            {t("userMenu.getHelp")}
          </a>
        </DropdownMenuItem>
        {!minimal && (
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
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void handleLogout()} className="flex items-center gap-2">
          <LogOut size={14} />
          {t("userMenu.logout")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
