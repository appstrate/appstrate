// SPDX-License-Identifier: Apache-2.0

/**
 * The products, as a segmented control rather than a menu (it stops scaling past four).
 * Icons are plain: the only coloured mark in the column is the organization's.
 * Docs & API is not a product: it is a link out, carried by the profile menu.
 */

import type { ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Blocks, MessageSquare } from "lucide-react";
import { cn } from "@appstrate/ui/cn";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { CountBadge } from "@/components/count-badge";
import { useSpaceAction, useSpacesFor } from "@/hooks/use-space-action";
import { usePermissions } from "@/hooks/use-permissions";
import { useChatUnreadCount, useHasChatSessions } from "@appstrate/module-chat/unread";
import { SHELL_CHAT_TRANSPORT } from "@/modules/chat/use-chat-runtime";
import { isChatTabShown } from "@/lib/chat-tab";
import { replacingNavigation, type SpaceChoiceMenu } from "@/lib/menu-action";
import { SpaceChoiceDropdown } from "@/components/space-choice-menu";
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
  /** Replaces the plain navigation (« Tous les espaces » acts in the space it takes). */
  onSelect?: () => void;
  /** The spaces to open it in, when the reader chooses: the tab opens their menu. */
  inSpaces?: SpaceChoiceMenu;
}

export function ProductTabs() {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  // The chat belongs to one space: in « Tous les espaces » it is offered where some space opens
  // it, and opened in the space the reader picks in the tab's menu.
  const chat = useSpaceAction({ route: "/chat" });
  const navigate = useNavigate();
  const { on: overview, offered: canWrite } = useSpacesFor({ permission: "chat:write" });
  const { ready } = usePermissions();
  const previewing = useViewAsHeader() !== null;
  const chatReachable = chat.offered;
  // The chat has no entry in the Studio's navigation: its unread count rides on this tab. Both
  // reads are the working space's, so « Tous les espaces » neither shows nor asks them (as
  // `NavOrg`): there the tab is offered where some space grants writing, own sessions counting
  // for none.
  const workingChat = chatReachable && !overview;
  const chatUnread = useChatUnreadCount(SHELL_CHAT_TRANSPORT, workingChat);
  const workingSessions = useHasChatSessions(SHELL_CHAT_TRANSPORT, workingChat);
  const hasChatSessions = overview ? false : workingSessions;
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
      ...chat.link("/chat"),
      inSpaces: chat.choose(t("spaceChoice.open"), () => navigate("/chat")),
      active: inChat,
      enabled: chatShown,
      unread: overview ? undefined : chatUnread,
    },
  ].filter((p) => p.enabled);

  // A toggle with one choice is noise; a slot still being decided keeps the row.
  if (products.length < 2 && !(chatPending && !chatShown)) return null;

  return (
    <div className="px-2 pt-4 pb-1">
      <nav
        aria-label={t("products.ariaLabel")}
        className="bg-sidebar-accent/40 flex gap-0.5 rounded-lg p-0.5"
      >
        {products.map((p) => (
          <SpaceChoiceDropdown key={p.id} choice={p.inSpaces}>
            <Link
              to={p.to}
              aria-current={p.active ? "page" : undefined}
              onClick={replacingNavigation(p.onSelect)}
              className={cn(
                "flex h-7 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-2 text-sm font-medium transition-colors",
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
          </SpaceChoiceDropdown>
        ))}
        {chatPending && !chatShown && <Skeleton className="h-7 flex-1 rounded-md" />}
      </nav>
    </div>
  );
}
