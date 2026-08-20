// SPDX-License-Identifier: Apache-2.0

/**
 * Product switcher, and the brand cell it lives in.
 *
 * The label that NAMES the current product is the control that changes it —
 * cause and effect in the same place. It also gives the shell a single grammar
 * for "this named thing can be swapped": label plus an up/down chevron, used
 * here for the product and again for the org/workspace chip, reading left to
 * right from the broadest scope to the narrowest.
 *
 * Deliberately not the nine-dot grid in the top-right corner: that is a suite
 * launcher, it promises a drawer of apps, and it sits in the corner that holds
 * personal things (notifications, profile) rather than working context.
 *
 * The whole cell opens the menu, so "click the logo to go home" is gone. That
 * convention earns its keep on a public site; here the Dashboard entry sits
 * directly underneath and does the same job without a second click target
 * eight pixels from the first.
 */
import type { ReactNode } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Blocks, Check, ChevronsUpDown, ExternalLink, Library, MessageSquare } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@appstrate/ui/components/dropdown-menu";
import { useAppConfig } from "@/hooks/use-app-config";
import { AppstrateMark } from "@/components/appstrate-mark";

const DOCS_URL = "https://docs.appstrate.dev";

interface Product {
  id: string;
  label: string;
  description: string;
  icon: ReactNode;
  /** Tailwind background for the icon tile. */
  tint: string;
  to?: string;
  href?: string;
  active: boolean;
  enabled: boolean;
}

export function ProductSwitcher() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { features } = useAppConfig();

  const inChat = pathname.startsWith("/chat");

  const products: Product[] = [
    {
      id: "studio",
      label: t("products.studio"),
      description: t("products.studioDescription"),
      icon: <Blocks className="size-[18px]" />,
      tint: "bg-primary",
      to: "/",
      active: !inChat,
      enabled: true,
    },
    {
      id: "chat",
      label: t("products.chat"),
      description: t("products.chatDescription"),
      icon: <MessageSquare className="size-[18px]" />,
      tint: "bg-spark",
      to: "/chat",
      active: inChat,
      enabled: Boolean(features.chat),
    },
    {
      id: "docs",
      label: t("products.docs"),
      description: t("products.docsDescription"),
      icon: <Library className="size-[18px]" />,
      tint: "bg-zinc-700",
      href: DOCS_URL,
      active: false,
      enabled: true,
    },
  ].filter((p) => p.enabled);

  const current = products.find((p) => p.active);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="product-switcher-button"
          aria-label={t("products.ariaLabel")}
          className="hover:bg-sidebar-accent data-[state=open]:bg-sidebar-accent flex w-full items-center justify-start gap-2 rounded-md py-1 pl-2 transition-colors group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
        >
          <AppstrateMark className="h-7 w-auto shrink-0" />
          <span className="truncate text-[1.02rem] font-semibold tracking-tight group-data-[collapsible=icon]:hidden">
            {current?.label ?? t("products.studio")}
          </span>
          <ChevronsUpDown className="text-muted-foreground size-3.5 shrink-0 group-data-[collapsible=icon]:hidden" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={6} className="w-[330px] rounded-xl p-1.5">
        {products.map((p) => (
          <DropdownMenuItem
            key={p.id}
            onSelect={() => {
              if (p.href) window.open(p.href, "_blank", "noopener,noreferrer");
              else if (p.to) navigate(p.to);
            }}
            data-active={p.active}
            className="data-[active=true]:bg-primary-soft flex items-center gap-3 rounded-lg p-2"
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
            {p.href && (
              <ExternalLink size={14} className="text-muted-foreground ml-auto shrink-0" />
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
