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
 * The icons are plain, not coloured tiles: the only coloured mark in the
 * column should be the organisation's own, one line up — two competing brands
 * in eight lines of chrome is one too many. Selection is carried by the
 * segmented control itself (white fill, shadow), which is what a tab strip is
 * for. In the icon rail the labels go and the icons stack, which is the only
 * part of this control that survives 48px.
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
import { useCanReach } from "@/hooks/use-can-reach";
import { usePermissions } from "@/hooks/use-permissions";
import { useChatUnreadCount, useHasChatSessions } from "@appstrate/module-chat/unread";
import { buildScopingHeaders } from "@/lib/scoping-headers";

interface Product {
  id: string;
  label: string;
  icon: ReactNode;
  to: string;
  active: boolean;
  enabled: boolean;
  /** Unread conversations, on the tab that leads to them. */
  unread?: number;
}

export function ProductTabs() {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const canReach = useCanReach();
  const { can } = usePermissions();
  const chatReachable = canReach("/chat");
  // The chat has no entry in the Studio's navigation: its unread count rides
  // on the tab that switches to it.
  const chatUnread = useChatUnreadCount(buildScopingHeaders, chatReachable);
  // Conversations are each person's own. A role that may read but not write
  // the chat (a viewer) only ever rereads what it wrote before: without any,
  // the tab would lead to a page with nothing to do.
  const hasChatSessions = useHasChatSessions(buildScopingHeaders, chatReachable);
  const chatShown = chatReachable && (can("chat:write") || hasChatSessions === true);

  // Studio owns every route the chat does not, so it cannot be matched by
  // prefix — it is the active one whenever the chat is not.
  const inChat = pathname.startsWith("/chat");

  const products: Product[] = [
    {
      id: "studio",
      label: t("products.studio"),
      icon: <Blocks className="size-4" />,
      to: "/",
      active: !inChat,
      enabled: true,
    },
    {
      id: "chat",
      label: t("products.chat"),
      icon: <MessageSquare className="size-4" />,
      to: "/chat",
      active: inChat,
      enabled: chatShown,
      unread: chatUnread,
    },
  ].filter((p) => p.enabled);

  return (
    <div
      role="tablist"
      aria-label={t("products.ariaLabel")}
      className="bg-sidebar-accent/40 flex gap-0.5 rounded-lg p-0.5"
    >
      {products.map((p) => (
        <Link
          key={p.id}
          to={p.to}
          role="tab"
          aria-selected={p.active}
          className={cn(
            "flex h-7 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-2 text-sm font-medium transition-colors",
            "",
            p.active
              ? "bg-card text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <span className="flex shrink-0 items-center justify-center">{p.icon}</span>
          <span className="truncate">{p.label}</span>
          {!p.active && (p.unread ?? 0) > 0 && (
            <span
              className="bg-primary text-primary-foreground rounded-full px-1.5 text-[10px] leading-4 font-semibold tabular-nums"
              aria-label={t("products.unread", { count: p.unread })}
            >
              {p.unread}
            </span>
          )}
        </Link>
      ))}
    </div>
  );
}
