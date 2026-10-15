// SPDX-License-Identifier: Apache-2.0

import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ShieldCheck } from "lucide-react";
import { Badge as UIBadge } from "@appstrate/ui/components/badge";
import { Card } from "@appstrate/ui/components/card";
import { RunStatusBadge } from "./status-badge";
import { CountBadge } from "./count-badge";
import { PackageIcon } from "./package-icon";
import { RunAgentButton } from "./run-agent-button";
import { packageDetailPath } from "../lib/package-paths";
import { ScrollArea, ScrollBar } from "@appstrate/ui/components/scroll-area";
import type { CardItem } from "../lib/package-card-item";

/**
 * An agent as a card on the dashboard: its tile, name and description, its
 * badges top right and its keywords. The card is ONE link, its title's,
 * stretched over the surface (`after:absolute after:inset-0`); what acts on
 * its own (run) is raised above it.
 */
const KEYWORD_PILL = "bg-background text-muted-foreground shrink-0 px-2 text-[0.7rem] font-normal";

export function PackageCard({
  id,
  displayName,
  description,
  type,
  source,
  version,
  runningRuns,
  keywords,
  unreadCount,
  identity,
  headingLevel = 2,
}: CardItem & {
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
    <Card className="hover:border-foreground/20 hover:bg-accent/50 relative flex h-full w-full flex-col p-4 transition-colors">
      {/* The icon tile sits LEFT of the title and its description, the way a
          store's card reads: what it is, then what it does. */}
      <div className="flex min-w-0 gap-3">
        <PackageIcon type={type} icon={identity?.icon} color={identity?.color} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <Heading className="text-foreground truncate text-sm font-medium">
                <Link to={packageDetailPath(type, id)} className={titleClass}>
                  {displayName}
                </Link>
              </Heading>
            </div>
            <div className="relative z-10 flex shrink-0 items-center gap-1.5">
              {source === "system" && (
                <span title={t("list.badgeBuiltIn")}>
                  <ShieldCheck
                    className="text-muted-foreground size-4"
                    role="img"
                    aria-label={t("list.badgeBuiltIn")}
                  />
                </span>
              )}
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
              {type === "agent" && (
                <RunAgentButton
                  packageId={id}
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground hover:text-primary size-7"
                />
              )}
            </div>
          </div>
          {/* Up to two lines, no reserved second one: no empty line under a short description. */}
          <p className="text-muted-foreground mt-0.5 line-clamp-2 text-xs">{description || ""}</p>
          {/* Under the description and still right of the icon: the text column
              never runs under the tile. */}
          {version && (
            <div className="text-muted-foreground/80 mt-2 flex min-w-0 items-center gap-2 text-xs">
              <UIBadge variant="secondary" className="shrink-0 font-mono text-[10px]">
                v{version}
              </UIBadge>
            </div>
          )}
        </div>
      </div>
      {keywords?.length ? (
        <ScrollArea className="relative z-10 mt-2 w-full">
          <div className="flex gap-1">
            {keywords?.map((kw) => (
              <UIBadge key={kw} variant="outline" className={KEYWORD_PILL}>
                {kw}
              </UIBadge>
            ))}
          </div>
          <ScrollBar orientation="horizontal" className="h-0 opacity-0" />
        </ScrollArea>
      ) : null}
    </Card>
  );
}
