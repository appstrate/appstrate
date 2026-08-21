// SPDX-License-Identifier: Apache-2.0

/**
 * The products, as tabs rather than a menu.
 *
 * There are two of them (three once the Inbox lands), and their names are what
 * you choose between — a segmented control names them all at once, where a
 * menu names one and hides the rest behind a click. It is also honest about
 * how far it scales: past four it stops working, and that is the point at
 * which a launcher would be the right answer instead.
 *
 * Each tab wears the tile its product wears everywhere else — Studio blue,
 * Chat coral — so the thing you press and the thing you get look alike. In the
 * icon rail the labels go and the tiles stack, which is the only part of this
 * control that survives 48px.
 *
 * Docs & API left the set: it is a link out, not a place in the app, and the
 * profile menu already carries it — where people look for documentation by
 * reflex anyway.
 */

import type { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Blocks, MessageSquare } from "lucide-react";
import { cn } from "@appstrate/ui/cn";
import { useAppConfig } from "@/hooks/use-app-config";

interface Product {
  id: string;
  label: string;
  icon: ReactNode;
  /** Tailwind background for the icon tile. */
  tint: string;
  to: string;
  active: boolean;
  enabled: boolean;
}

export function ProductTabs() {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const { features } = useAppConfig();

  // Studio owns every route the chat does not, so it cannot be matched by
  // prefix — it is the active one whenever the chat is not.
  const inChat = pathname.startsWith("/chat");

  const products: Product[] = [
    {
      id: "studio",
      label: t("products.studio"),
      icon: <Blocks className="size-[15px]" />,
      tint: "bg-primary",
      to: "/",
      active: !inChat,
      enabled: true,
    },
    {
      id: "chat",
      label: t("products.chat"),
      icon: <MessageSquare className="size-[15px]" />,
      tint: "bg-spark",
      to: "/chat",
      active: inChat,
      enabled: Boolean(features.chat),
    },
  ].filter((p) => p.enabled);

  return (
    <div
      role="tablist"
      aria-label={t("products.ariaLabel")}
      className="bg-sidebar-accent/70 flex gap-1 rounded-lg p-1 group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:gap-1.5 group-data-[collapsible=icon]:bg-transparent group-data-[collapsible=icon]:p-0"
    >
      {products.map((p) => (
        <Link
          key={p.id}
          to={p.to}
          role="tab"
          aria-selected={p.active}
          className={cn(
            "flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-sm font-medium transition-colors",
            "group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:flex-none group-data-[collapsible=icon]:px-0!",
            p.active
              ? "bg-card text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <span
            className={`${p.tint} flex size-5 shrink-0 items-center justify-center rounded-[5px] text-white group-data-[collapsible=icon]:size-6 group-data-[collapsible=icon]:rounded-md`}
          >
            {p.icon}
          </span>
          <span className="truncate group-data-[collapsible=icon]:hidden">{p.label}</span>
        </Link>
      ))}
    </div>
  );
}
