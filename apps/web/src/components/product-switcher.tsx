// SPDX-License-Identifier: Apache-2.0

/**
 * Product switcher, sitting next to the profile.
 *
 * Studio and Chat are separate PRODUCTS, not two entries in one sidebar. That
 * is why the chat no longer appears in the navigation: moving between them is
 * a change of surface, like changing organisation, not a change of page.
 */
import { useNavigate, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Check, MessageSquare } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@appstrate/ui/components/dropdown-menu";
import { useAppConfig } from "@/hooks/use-app-config";
import { AppstrateMark } from "@/components/appstrate-mark";

/** The redesign's nine-dot grid. No lucide glyph matches it. */
function GridIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      {[5, 12, 19].map((cy) =>
        [5, 12, 19].map((cx) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="1.7" />),
      )}
    </svg>
  );
}

export function ProductSwitcher() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { features } = useAppConfig();

  const products = [
    {
      id: "studio",
      label: t("products.studio"),
      description: t("products.studioDescription"),
      to: "/",
      active: !pathname.startsWith("/chat"),
      icon: <AppstrateMark className="h-5 w-auto text-white" />,
      tint: "bg-primary",
      enabled: true,
    },
    {
      id: "chat",
      label: t("products.chat"),
      description: t("products.chatDescription"),
      to: "/chat",
      active: pathname.startsWith("/chat"),
      icon: <MessageSquare className="size-[18px]" />,
      tint: "bg-spark",
      enabled: Boolean(features.chat),
    },
  ].filter((p) => p.enabled);

  if (products.length < 2) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t("products.ariaLabel")}>
          <GridIcon className="size-[19px]" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6} className="w-[330px] rounded-xl p-1.5">
        {products.map((p) => (
          <DropdownMenuItem
            key={p.id}
            onSelect={() => navigate(p.to)}
            className="data-[active=true]:bg-accent flex items-center gap-3 rounded-lg p-2"
            data-active={p.active}
          >
            <span
              className={`${p.tint} flex size-9 shrink-0 items-center justify-center rounded-lg text-white`}
            >
              {p.icon}
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="text-sm font-semibold">{p.label}</span>
              <span className="text-muted-foreground text-xs">{p.description}</span>
            </span>
            {p.active && <Check size={15} className="text-primary ml-auto shrink-0" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
