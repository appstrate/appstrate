// SPDX-License-Identifier: Apache-2.0

import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { DOCS_URL, SUPPORT_URL } from "@/lib/external-links";
import { BookOpen, Check, FileText, LifeBuoy, LogOut, Palette, Settings } from "lucide-react";
import { useAuth, useViewer } from "../hooks/use-auth";
import type { SpaceViewer } from "../lib/space-label";
import { useTheme } from "../stores/theme-store";
import { themeOptions } from "../lib/theme";
import { IdentityTile } from "@appstrate/ui/components/identity-tile";
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

/** The signed-in person: their initials on the identity colour hashed from their id. */
function UserAvatar({ viewer, className }: { viewer: SpaceViewer; className: string }) {
  return <IdentityTile seed={viewer.id} label={viewer.name} shape="round" className={className} />;
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
  const { user, logout } = useAuth();
  const viewer = useViewer();
  const { theme, setTheme } = useTheme();

  if (!user || !viewer) return null;

  const row = variant === "row";
  const minimal = variant === "minimal";
  const displayName = viewer.name;
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
            <UserAvatar viewer={viewer} className="size-7" />
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
            <UserAvatar viewer={viewer} className="size-8" />
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
            <UserAvatar viewer={viewer} className="size-8 rounded-lg" />
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
            {themeOptions.map(({ value, labelKey, icon: Icon }) => (
              <DropdownMenuItem key={value} onSelect={() => setTheme(value)}>
                <Icon />
                {t(labelKey)}
                {theme === value && (
                  <Check strokeWidth={2.5} className="text-primary ml-auto shrink-0" />
                )}
              </DropdownMenuItem>
            ))}
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
