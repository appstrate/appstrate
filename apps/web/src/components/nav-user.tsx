// SPDX-License-Identifier: Apache-2.0

import { Link } from "react-router-dom";
import { ManualSetting } from "./settings/manual-save";
import { useTranslation } from "react-i18next";
import { DOCS_URL, SUPPORT_URL } from "@/lib/external-links";
import { BookOpen, Check, FileText, LifeBuoy, LogOut, Palette, Settings } from "lucide-react";
import { useAuth } from "../hooks/use-auth";
import { useTheme } from "../stores/theme-store";
import { themeOptions } from "../lib/theme";
import { initials } from "../lib/initials";
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

function UserAvatar({ letters, className }: { letters: string; className: string }) {
  return (
    <Avatar className={className}>
      <AvatarFallback className="bg-spark text-spark-foreground rounded-[inherit] font-medium">
        {letters}
      </AvatarFallback>
    </Avatar>
  );
}

interface NavUserProps {
  /**
   * `row` is the full-width identity line at the foot of the sidebar (avatar, name, email).
   * `minimal` is the round avatar button of the onboarding flow, with only the entries that
   * need no organization: `/preferences` sits behind `OrgGate`, which bounces an org-less
   * user straight back to `/onboarding/create`.
   */
  variant: "row" | "minimal";
}

export function NavUser({ variant }: NavUserProps) {
  const { t } = useTranslation();
  const { user, profile, logout } = useAuth();
  const { theme, setTheme } = useTheme();

  if (!user) return null;

  const row = variant === "row";
  const minimal = variant === "minimal";
  const displayName = profile?.displayName || user.email || "";
  const userInitials = initials(profile?.displayName, user.email);
  // Documentation and support live here as well as in the product switcher. The duplication is
  // deliberate: this menu is where people look for help by habit.
  const links = [
    { href: DOCS_URL, icon: BookOpen, label: t("userMenu.documentation") },
    { href: SUPPORT_URL, icon: LifeBuoy, label: t("userMenu.getHelp") },
    ...(minimal ? [] : [{ href: "/api/docs", icon: FileText, label: t("userMenu.apiDocs") }]),
  ];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {row ? (
          <button
            type="button"
            aria-label={t("userMenu.ariaLabel")}
            className="hover:bg-sidebar-accent data-[state=open]:bg-sidebar-accent flex w-full items-center gap-2 rounded-md p-2 text-left transition-colors"
          >
            <UserAvatar letters={userInitials} className="size-7 text-xs" />
            <span className="grid min-w-0 flex-1 leading-tight">
              <span className="truncate text-sm font-medium">{displayName}</span>
              <span className="text-muted-foreground truncate text-xs">{user.email}</span>
            </span>
          </button>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("userMenu.ariaLabel")}
            className="rounded-full"
          >
            <UserAvatar letters={userInitials} className="size-8 text-sm" />
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className="min-w-56 rounded-lg"
        side={row ? "right" : "bottom"}
        align="end"
        sideOffset={4}
      >
        <DropdownMenuLabel className="p-0 font-normal">
          <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
            <UserAvatar letters={userInitials} className="size-8 rounded-lg text-sm" />
            <div className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-semibold">{displayName}</span>
              <span className="truncate text-xs">{user.email}</span>
            </div>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {!minimal && (
          <DropdownMenuItem asChild>
            <Link to="/preferences">
              <Settings />
              {t("userMenu.preferences")}
            </Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Palette />
            {t("userMenu.theme")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
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
                      <Icon />
                      {t(labelKey)}
                      {draft === value && (
                        <Check strokeWidth={2.5} className="text-primary ml-auto shrink-0" />
                      )}
                    </DropdownMenuItem>
                  ))}
                </>
              )}
            </ManualSetting>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {links.map(({ href, icon: Icon, label }) => (
          <DropdownMenuItem key={href} asChild>
            <a href={href} target="_blank" rel="noopener noreferrer">
              <Icon />
              {label}
            </a>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void logout()}>
          <LogOut />
          {t("userMenu.logout")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
