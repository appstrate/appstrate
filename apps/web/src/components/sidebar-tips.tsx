// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState, type FocusEvent, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  ArrowUp,
  CalendarClock,
  LibraryBig,
  MessageSquarePlus,
  Plug,
  Plus,
  UserPlus,
  UserRound,
  X,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { cn } from "@appstrate/ui/cn";
import { IDENTITY_COLOR_CLASSES } from "@appstrate/ui/identity-colors";
import { $api } from "../api/client";
import { useAuth } from "../hooks/use-auth";
import { useCanReach } from "../hooks/use-can-reach";
import { useMyConnections } from "../hooks/use-me-connections";
import { useCurrentOrgId, useOrgDetail } from "../hooks/use-org";
import { useSpaceReadScope } from "../hooks/use-org-scope";
import { useOverviewMode } from "../hooks/use-overview-mode";
import { useAgents } from "../hooks/use-packages";
import { usePermissions } from "../hooks/use-permissions";
import { useAllSchedules } from "../hooks/use-schedules";
import { useOverlayPath } from "../lib/modal-route";
import { overlayIntent } from "../lib/overlay-chunks";
import { PACKAGE_TYPE_ICON } from "../lib/package-type-icon";
import {
  SIDEBAR_TIP_TARGET,
  sidebarTips,
  type SidebarTipFacts,
  type SidebarTipId,
} from "../lib/sidebar-tips";
import { dismissedTipsStore } from "../stores/sidebar-tips-store";
import { PackageIcon } from "./package-icon";

/** How long a card stays on top before the next one takes its place. */
const TIP_ROTATION_MS = 6000;

/** How long a card takes to leave the top: `duration-base`, the transition it runs. */
const TIP_LEAVE_MS = 250;

/** The tile colour of each package type on the catalogue card. */
const CATALOGUE_TILES = [
  { type: "agent", color: "violet" },
  { type: "skill", color: "amber" },
  { type: "integration", color: "emerald" },
] as const;

/** Literal keys, so the locale check sees every one of them. */
const TIP_COPY: Record<
  SidebarTipId,
  { icon: LucideIcon; title: string; text: string; action: string }
> = {
  connect: {
    icon: Plug,
    title: "tips.connect.title",
    text: "tips.connect.text",
    action: "tips.connect.action",
  },
  chat: {
    icon: MessageSquarePlus,
    title: "tips.chat.title",
    text: "tips.chat.text",
    action: "tips.chat.action",
  },
  invite: {
    icon: UserPlus,
    title: "tips.invite.title",
    text: "tips.invite.text",
    action: "tips.invite.action",
  },
  schedule: {
    icon: CalendarClock,
    title: "tips.schedule.title",
    text: "tips.schedule.text",
    action: "tips.schedule.action",
  },
  catalogue: {
    icon: LibraryBig,
    title: "tips.catalogue.title",
    text: "tips.catalogue.text",
    action: "tips.catalogue.action",
  },
};

/**
 * What the cards are decided on, each read only while its card could still show: a dismissed
 * card, or one the caller's role closes, asks the server nothing.
 */
function useSidebarTipFacts(dismissed: readonly string[]): SidebarTipFacts {
  const canReach = useCanReach();
  const { can } = usePermissions();
  const { on: overview } = useOverviewMode();
  const orgId = useCurrentOrgId();
  const open = (id: SidebarTipId, allowed: boolean) => allowed && !dismissed.includes(id);

  const canConnect = canReach("/integrations");
  // Both act in the working space: « Tous les espaces » has none.
  const canCreateWithChat = !overview && canReach("/chat") && can("agents:write");
  const canSchedule = !overview && canReach("/schedules") && can("schedules:write");
  const canInvite = can("members:invite");

  const connections = useMyConnections(open("connect", canConnect));
  const conversations = $api.useQuery(
    "get",
    "/api/orgs/{orgId}/chat/sessions",
    { params: { path: { orgId: orgId ?? "" }, query: { limit: 1 } } },
    { enabled: !!orgId && open("chat", canCreateWithChat) },
  );
  const agents = useAgents({ enabled: open("schedule", canSchedule) });
  const schedules = useAllSchedules(false, open("schedule", canSchedule));
  const org = useOrgDetail({ enabled: open("invite", canInvite) });

  return {
    connections: connections.data?.reduce(
      (count, group) => count + group.connections.filter((c) => c.org.id === orgId).length,
      0,
    ),
    conversations: conversations.data?.data.length,
    agents: open("schedule", canSchedule) ? agents.data?.length : undefined,
    schedules: open("schedule", canSchedule) ? schedules.data?.length : undefined,
    people: org.data?.members
      ? org.data.members.length + (org.data.invitations?.length ?? 0)
      : undefined,
    canConnect,
    canCreateWithChat,
    canInvite,
    canSchedule,
    canBrowseCatalogue: canReach("/catalogue"),
  };
}

/**
 * The getting-started cards at the foot of the desktop sidebar: one on top, the next peeking
 * above it. They take turns every {@link TIP_ROTATION_MS}, hold still while the pointer or the
 * focus is on them, and stop for good once the person turns one by hand. A card leaves when its
 * step is done or when it is dismissed (per user, in this browser).
 */
export function SidebarTips() {
  const { user } = useAuth();
  const [dismissed, setDismissed] = dismissedTipsStore.useValue(user?.id ?? "");
  const facts = useSidebarTipFacts(dismissed);
  const { pathname } = useLocation();
  const overlayPath = useOverlayPath();
  const tips = sidebarTips(facts, dismissed, overlayPath ? [pathname, overlayPath] : [pathname]);
  if (!user || tips.length === 0) return null;
  return <TipStack tips={tips} onDismiss={(id) => setDismissed([...dismissed, id])} />;
}

function TipStack({
  tips,
  onDismiss,
}: {
  tips: readonly SidebarTipId[];
  onDismiss: (id: SidebarTipId) => void;
}) {
  const { t } = useTranslation();
  // The card on top, by id: a card arriving or leaving as its data lands never moves another.
  const [topId, setTopId] = useState<SidebarTipId | null>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [turnedByHand, setTurnedByHand] = useState(false);
  // The card sliding off the top, drawn above the stack until it has faded out.
  const [leaving, setLeaving] = useState<SidebarTipId | null>(null);
  const count = tips.length;
  const top = Math.max(0, topId === null ? 0 : tips.indexOf(topId));
  const current = tips[top]!;
  const next = tips[(top + 1) % count]!;
  const rotating = count > 1 && !hovered && !focused && !turnedByHand;

  useEffect(() => {
    if (!rotating) return;
    const timer = setTimeout(() => {
      setLeaving(current);
      setTopId(next);
    }, TIP_ROTATION_MS);
    return () => clearTimeout(timer);
  }, [rotating, current, next]);

  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => setLeaving(null), TIP_LEAVE_MS);
    return () => clearTimeout(timer);
  }, [leaving]);

  const onBlur = (event: FocusEvent<HTMLElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
  };

  return (
    <section
      aria-label={t("tips.label")}
      data-testid="sidebar-tips"
      className={cn(
        "group/tips duration-base ease-surface relative px-2 pt-2 pb-2 transition-[padding] [@media(max-height:759px)]:hidden",
        count > 1 && "hover:pt-7",
      )}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={onBlur}
    >
      {count > 1 && (
        <button
          type="button"
          aria-label={t("tips.next", { title: t(TIP_COPY[next].title) })}
          className="focus-visible:ring-ring absolute inset-x-2 top-0 z-40 h-2 cursor-pointer rounded-t-lg outline-none group-hover/tips:h-7 focus-visible:ring-2"
          onClick={() => {
            setTurnedByHand(true);
            setLeaving(current);
            setTopId(next);
          }}
        />
      )}
      <div className="grid grid-cols-[minmax(0,1fr)]">
        {tips.map((id, index) => {
          const depth = (index - top + count) % count;
          const isLeaving = id === leaving && depth !== 0;
          return (
            <div
              key={id}
              inert={depth !== 0}
              data-tip={id}
              data-depth={depth}
              className={cn(
                "duration-base ease-surface min-w-0 origin-top transition-[opacity,translate,scale] [grid-area:1/1]",
                // The card leaving the top slides down a little as it fades, over the one taking
                // its place, which comes forward from behind.
                isLeaving && "pointer-events-none z-[35] translate-y-2.5 scale-[0.94] opacity-0",
                !isLeaving && depth === 0 && "z-30",
                !isLeaving &&
                  depth === 1 &&
                  "z-20 -translate-y-2 scale-[0.94] group-hover/tips:-translate-y-7",
                !isLeaving && depth > 1 && "z-10 scale-[0.88] opacity-0",
              )}
            >
              <TipCard
                id={id}
                onTop={depth === 0}
                onDismiss={() => {
                  // The card that followed takes the dismissed one's place, not the first.
                  setTopId(next);
                  onDismiss(id);
                }}
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}

function TipCard({
  id,
  onTop,
  onDismiss,
}: {
  id: SidebarTipId;
  onTop: boolean;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const copy = TIP_COPY[id];
  const Icon = copy.icon;
  const title = t(copy.title);
  const target = SIDEBAR_TIP_TARGET[id];
  return (
    <div className="bg-card text-card-foreground border-sidebar-border relative flex h-full flex-col gap-2.5 rounded-lg border p-3 shadow-xs">
      {/* Only the card on top is dismissed: the one peeking behind shows its title alone. */}
      {onTop && (
        <Button
          type="button"
          variant="ghost"
          aria-label={t("tips.dismiss", { title })}
          className="text-muted-foreground absolute top-1.5 right-1.5 size-6 p-0 opacity-0 transition-opacity group-hover/tips:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
          onClick={onDismiss}
        >
          <X className="size-3.5" aria-hidden="true" />
        </Button>
      )}
      <div className="flex flex-col gap-0.5">
        <p className="flex items-center gap-1.5 pr-5 text-sm font-semibold">
          <Icon className="text-primary size-4 shrink-0" aria-hidden="true" />
          {title}
        </p>
        <p className="text-muted-foreground line-clamp-2 min-h-[2lh] text-sm leading-snug">
          {t(copy.text)}
        </p>
      </div>
      <div aria-hidden="true" className="flex h-7 min-w-0 items-center">
        <TipVisual id={id} />
      </div>
      <Button
        asChild
        variant="outline"
        size="sm"
        className="bg-muted/40 mt-auto h-8 w-full shadow-xs"
      >
        <Link to={target} {...overlayIntent(target)}>
          {t(copy.action)}
        </Link>
      </Button>
    </div>
  );
}

/** A round tile of the visual row. */
function Disc({ className, children }: { className?: string; children?: ReactNode }) {
  return (
    <span
      className={cn(
        "flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full",
        className,
      )}
    >
      {children}
    </span>
  );
}

function TipVisual({ id }: { id: SidebarTipId }) {
  const { t } = useTranslation();
  switch (id) {
    case "connect":
      return <IntegrationSamples />;
    case "chat":
      return (
        <span className="border-border text-muted-foreground flex h-7 min-w-0 flex-1 items-center gap-2 rounded-full border pr-1 pl-3 text-xs">
          <span className="truncate">{t("tips.chat.example")}</span>
          <span className="bg-primary text-primary-foreground ml-auto flex size-5 shrink-0 items-center justify-center rounded-full">
            <ArrowUp className="size-3" />
          </span>
        </span>
      );
    case "invite":
      return (
        <span className="flex gap-1.5">
          <Disc className={IDENTITY_COLOR_CLASSES.blue}>
            <UserRound className="size-4" />
          </Disc>
          {(["emerald", "pink"] as const).map((color) => (
            <Disc key={color} className={IDENTITY_COLOR_CLASSES[color]}>
              <Plus className="size-3.5" />
            </Disc>
          ))}
        </span>
      );
    case "schedule":
      return (
        <span className="flex gap-1.5 text-xs">
          <span className={cn(IDENTITY_COLOR_CLASSES.blue, "rounded-md px-2 py-1")}>
            {t("tips.schedule.days")}
          </span>
          <span className={cn(IDENTITY_COLOR_CLASSES.amber, "rounded-md px-2 py-1 tabular-nums")}>
            {t("tips.schedule.time")}
          </span>
        </span>
      );
    case "catalogue":
      return (
        <span className="flex gap-1.5">
          {CATALOGUE_TILES.map(({ type, color }) => {
            const Glyph = PACKAGE_TYPE_ICON[type];
            return (
              <Disc key={type} className={cn(IDENTITY_COLOR_CLASSES[color], "rounded-md")}>
                <Glyph className="size-4" />
              </Disc>
            );
          })}
        </span>
      );
  }
}

/** Logos shown on the connect card. */
const SAMPLE_LOGOS = 5;

/** A few of the space's integrations as logos, then how many more there are. */
function IntegrationSamples() {
  const scope = useSpaceReadScope("integrations:read");
  const { data } = $api.useQuery(
    "get",
    "/api/integrations",
    { params: { query: { limit: SAMPLE_LOGOS, fields: "id,manifest" }, header: scope.header } },
    { enabled: scope.enabled },
  );
  if (!data) return null;
  const more = data.total - data.data.length;
  return (
    <span className="flex w-full items-center gap-1.5">
      {data.data.map((row) => (
        <Disc key={row.id} className="border-border bg-background rounded-md border">
          <PackageIcon type="integration" icon={iconOf(row.manifest)} size="xs" />
        </Disc>
      ))}
      {more > 0 && (
        <span className="text-muted-foreground ml-auto text-xs tabular-nums">+{more}</span>
      )}
    </span>
  );
}

function iconOf(manifest: unknown): string | undefined {
  const icon = (manifest as { icon?: unknown } | undefined)?.icon;
  return typeof icon === "string" ? icon : undefined;
}
