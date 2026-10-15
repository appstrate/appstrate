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
 * column should be the organization's own, one line up. Selection is carried
 * by the segmented control itself (white fill, shadow).
 *
 * Docs & API is not a product: it is a link out, carried by the profile menu.
 */

import type { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Blocks, MessageSquare } from "lucide-react";
import { cn } from "@appstrate/ui/cn";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { useCanReach } from "@/hooks/use-can-reach";
import { usePermissions } from "@/hooks/use-permissions";
import { useChatUnreadCount, useHasChatSessions } from "@appstrate/module-chat/unread";
import { buildScopingHeaders } from "@/lib/scoping-headers";
import { isChatTabShown } from "@/lib/chat-tab";
import { useViewAsHeader } from "@/stores/view-as-store";

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
  const { can, ready } = usePermissions();
  const previewing = useViewAsHeader() !== null;
  const chatReachable = canReach("/chat");
  // The chat has no entry in the Studio's navigation: its unread count rides
  // on the tab that switches to it.
  const chatUnread = useChatUnreadCount(buildScopingHeaders, chatReachable);
  const hasChatSessions = useHasChatSessions(buildScopingHeaders, chatReachable);
  const chatShown = isChatTabShown({
    reachable: chatReachable,
    canWrite: can("chat:write"),
    previewing,
    hasOwnSessions: hasChatSessions,
  });

  // Whether the Chat tab is still undecided: its permission set, or (for a
  // reader) the answer to "do I have conversations" — the slot is reserved so
  // Studio does not fill the row and then split when Chat appears.
  const chatPending =
    !ready || (chatReachable && !can("chat:write") && !previewing && hasChatSessions === undefined);

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
    <nav
      aria-label={t("products.ariaLabel")}
      className="bg-sidebar-accent/40 flex gap-0.5 rounded-lg p-0.5"
    >
      {products.map((p) => (
        <Link
          key={p.id}
          to={p.to}
          aria-current={p.active ? "page" : undefined}
          className={cn(
            "flex h-7 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-2 text-sm font-medium transition-colors",
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
      {chatPending && !chatShown && <Skeleton className="h-7 flex-1 rounded-md" />}
    </nav>
  );
}
