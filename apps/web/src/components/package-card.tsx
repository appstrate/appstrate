// SPDX-License-Identifier: Apache-2.0

import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ShieldCheck } from "lucide-react";
import { Badge as UIBadge } from "@appstrate/ui/components/badge";
import { RunStatusBadge, MetaBadge } from "./status-badge";
import { CountBadge } from "./count-badge";
import { PackageIcon } from "./package-icon";
import { RunAgentButton } from "./run-agent-button";
import { packageDetailPath } from "../lib/package-paths";
import { ScrollArea, ScrollBar } from "@appstrate/ui/components/scroll-area";
import type { CardItem } from "../lib/package-card-item";

/**
 * A package as a card, the same on every surface (the dashboard, the index
 * pages, the catalogue): its tile, name and description, its badges top right,
 * its keywords and an optional footer. The card is ONE link, its title's,
 * stretched over the surface (`after:absolute after:inset-0`); what acts on
 * its own (run, the state control, the footer) is raised above it.
 */
export function PackageCard({
  id,
  displayName,
  description,
  type,
  source,
  version,
  runningRuns,
  keywords,
  usedByAgents,
  unreadCount,
  actions,
  autoInstalled,
  icon,
  identity,
  logo,
  status,
  meta,
  showRun = true,
  onOpen,
  headingLevel = 2,
}: CardItem & {
  /**
   * Whether an agent card offers to run it. False in the catalogue: a package
   * this space has not activated cannot be run from here, and the button would
   * make those cards a row taller than the rest.
   */
  showRun?: boolean;
  /** Read it in place instead of navigating — what the catalogue's rows do. */
  onOpen?: () => void;
  /** 3 where the cards sit under a section's `<h2>` (the dashboard). */
  headingLevel?: 2 | 3;
}) {
  const { t } = useTranslation(["agents", "settings", "common"]);
  // The focus ring is drawn on the stretched overlay, i.e. around the whole
  // card: on the title itself `truncate` would clip it.
  const titleClass =
    "truncate outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:after:ring-2 focus-visible:after:ring-ring";
  const Heading = headingLevel === 3 ? "h3" : "h2";

  return (
    <div className="border-border bg-card hover:border-foreground/20 hover:bg-accent/50 relative flex h-full w-full flex-col rounded-lg border p-4 transition-colors">
      {/* The icon tile sits LEFT of the title and its description, the way a
          store's card reads: what it is, then what it does. */}
      <div className="flex min-w-0 gap-3">
        {icon ?? (
          <PackageIcon
            type={type}
            icon={type === "agent" ? identity?.icon : logo}
            color={identity?.color}
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <Heading className="text-foreground truncate text-sm font-medium">
                {onOpen ? (
                  <button type="button" className={titleClass} onClick={onOpen}>
                    {displayName}
                  </button>
                ) : (
                  <Link to={packageDetailPath(type, id)} className={titleClass}>
                    {displayName}
                  </Link>
                )}
              </Heading>
            </div>
            <div className="relative z-10 flex shrink-0 items-center gap-1.5">
              {source === "system" && (
                <span title={t("list.badgeBuiltIn")}>
                  <ShieldCheck
                    className="text-muted-foreground h-4 w-4"
                    role="img"
                    aria-label={t("list.badgeBuiltIn")}
                  />
                </span>
              )}
              {autoInstalled && <MetaBadge label={t("list.badgeAutoInstalled")} />}
              <CountBadge
                count={unreadCount ?? 0}
                label={t("dashboard.unreadRuns", { ns: "agents", count: unreadCount ?? 0 })}
              />
              {type === "agent" && !!runningRuns && runningRuns > 0 && (
                <RunStatusBadge status="running" />
              )}
              {/* Listed here IS runnable here: the index and the launch routes
                  read the same rule (placed in this space and switched on), so
                  the card never has to explain an activation the row could not
                  carry. A package placed here but switched off is not on this
                  list at all — it is in the space library, with its switch. */}
              {type === "agent" && showRun && (
                <RunAgentButton
                  packageId={id}
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground hover:text-primary size-7"
                />
              )}
            </div>
          </div>
          {/* Up to two lines, no reserved second one: the grid stretches every
          card of a row to the tallest and the footer sits at the bottom
          (`mt-auto`), so rows stay aligned without an empty line under a
          short description. */}
          <p className="text-muted-foreground mt-0.5 line-clamp-2 text-xs">{description || ""}</p>
          {/* Under the description and still right of the icon: the text column
              never runs under the tile. */}
          {(version || meta) && (
            <div className="text-muted-foreground/80 mt-2 flex min-w-0 items-center gap-2 text-xs">
              {version && (
                <UIBadge variant="secondary" className="shrink-0 font-mono text-[10px]">
                  v{version}
                </UIBadge>
              )}
              {meta}
            </div>
          )}
        </div>
        {/* Its own column, top-aligned with the title, the way a store's "+"
            sits: the text wraps before it instead of running underneath. */}
        {status && <div className="relative z-10 shrink-0 self-start">{status}</div>}
      </div>
      {keywords?.length || (type !== "agent" && (usedByAgents ?? 0) > 0) ? (
        <ScrollArea className="relative z-10 mt-2 w-full">
          <div className="flex gap-1">
            {keywords?.map((kw) => (
              <span
                key={kw}
                className="bg-background text-muted-foreground border-border shrink-0 rounded-full border px-2 py-0.5 text-[0.7rem]"
              >
                {kw}
              </span>
            ))}
            {type !== "agent" && usedByAgents !== undefined && usedByAgents > 0 && (
              <span className="bg-background text-muted-foreground border-border shrink-0 rounded-full border px-2 py-0.5 text-[0.7rem]">
                {t("list.usedByAgents", { count: usedByAgents, ns: "agents" })}
              </span>
            )}
          </div>
          <ScrollBar orientation="horizontal" className="h-0 opacity-0" />
        </ScrollArea>
      ) : null}
      {actions && <div className="min-h-3" aria-hidden />}
      {actions && (
        <div
          // `min-h-8` so a footer carrying a button and one carrying a line of
          // text are the same height, which is what kept the rows ragged.
          className="border-border relative z-10 mt-auto flex min-h-8 items-center justify-between gap-2 border-t pt-3"
        >
          {actions}
        </div>
      )}
    </div>
  );
}
