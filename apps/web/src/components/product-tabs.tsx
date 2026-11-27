// SPDX-License-Identifier: Apache-2.0

/**
 * The products, as a segmented control rather than a menu (it stops scaling past four).
 * Icons are plain: the only coloured mark in the column is the organization's.
 * Docs & API is not a product: it is a link out, carried by the profile menu.
 * On a phone a tab leaves the navigation sheet open on the product it picked, the page behind
 * moving to that product's landing (`lib/drawer-navigation.ts`).
 */

import type { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Blocks, MessageSquare } from "lucide-react";
import { cn } from "@appstrate/ui/cn";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { CountBadge } from "@/components/count-badge";
import { useCanReach, useStudioReach } from "@/hooks/use-can-reach";
import { usePermissions } from "@/hooks/use-permissions";
import { useChatUnreadCount, useHasChatSessions } from "@appstrate/module-chat/unread";
import { useChatCan, useShellChatTransport } from "@/modules/chat/use-chat-runtime";
import { isChatTabShown } from "@/lib/chat-tab";
import { KEEP_DRAWER_OPEN } from "@/lib/drawer-navigation";
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
  // The chat serves the organization in every mode (its sessions act across spaces): it is offered
  // where some space opens it, and writable where it may act (the acting set), whatever the
  // working space grants.
  const canReach = useCanReach();
  const chatReachable = canReach("/chat");
  const studio = useStudioReach();
  const canWrite = useChatCan()("chat:write");
  const { ready } = usePermissions();
  const previewing = useViewAsHeader() !== null;
  // The chat has no entry in the Studio's navigation: its unread count rides on this tab, the
  // working space's, or in « Tous les espaces » the organization's.
  const chatTransport = useShellChatTransport();
  const chatUnread = useChatUnreadCount(chatTransport, chatReachable);
  const hasChatSessions = useHasChatSessions(chatTransport, chatReachable);
  const chatShown = isChatTabShown({
    reachable: chatReachable,
    canWrite,
    previewing,
    hasOwnSessions: hasChatSessions,
  });

  // The Chat tab is still undecided: its slot is reserved so Studio does not fill the row then split.
  const chatPending =
    !ready || (chatReachable && !canWrite && !previewing && hasChatSessions === undefined);

  // Studio owns every route the chat does not, so it is active whenever the chat is not.
  const inChat = pathname.startsWith("/chat");

  // The chat leads: it is the reader's home wherever it is theirs (`useHome`).
  const products: Product[] = [
    {
      id: "chat",
      label: t("products.chat"),
      icon: <MessageSquare className="size-4" />,
      to: "/chat",
      active: inChat,
      enabled: chatShown,
      unread: chatUnread,
    },
    {
      id: "studio",
      label: t("products.studio"),
      icon: <Blocks className="size-4" />,
      to: "/dashboard",
      active: !inChat,
      enabled: studio,
    },
  ].filter((p) => p.enabled);

  // A toggle with one choice is noise; a slot still being decided keeps the row.
  const chatDeciding = chatPending && !chatShown;
  const studioDeciding = !ready && !studio;
  if (products.length + Number(chatDeciding) + Number(studioDeciding) < 2) return null;

  return (
    <div className="px-2 pt-4 pb-1">
      <nav
        aria-label={t("products.ariaLabel")}
        className="bg-sidebar-accent/40 flex gap-0.5 rounded-lg p-0.5"
      >
        {chatDeciding && <Skeleton className="desktop-pointer:h-7 h-10 flex-1 rounded-md" />}
        {products.map((p) => (
          <Link
            key={p.id}
            to={p.to}
            state={KEEP_DRAWER_OPEN}
            aria-current={p.active ? "page" : undefined}
            className={cn(
              "desktop-pointer:h-7 flex h-10 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-2 text-sm font-medium transition-colors",
              p.active
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <span className="flex shrink-0 items-center justify-center">{p.icon}</span>
            <span className="truncate">{p.label}</span>
            {!p.active && (
              <CountBadge
                count={p.unread ?? 0}
                label={t("products.unread", { count: p.unread })}
                tone="primary"
              />
            )}
          </Link>
        ))}
        {studioDeciding && <Skeleton className="desktop-pointer:h-7 h-10 flex-1 rounded-md" />}
      </nav>
    </div>
  );
}
