// SPDX-License-Identifier: Apache-2.0

/**
 * The composer's `/` menu: a listbox above the composer card, driven from the input (which keeps
 * the focus, `aria-activedescendant` names the active option). The rules are in `slash-menu.ts`,
 * the state in `use-slash-menu.ts`.
 */

import { BookOpenIcon, BotIcon, CheckIcon } from "lucide-react";
import { Badge } from "@appstrate/ui/components/badge";
import { cn } from "@appstrate/ui/cn";
import { MAX_PINNED_SKILLS } from "../skills.ts";
import { useChatHost } from "./runtime-context.ts";
import type { SlashEntry } from "./slash-menu.ts";
import { optionId } from "./use-slash-menu.ts";

interface SlashMenuListProps {
  entries: readonly SlashEntry[];
  active: number;
  listId: string;
  onChoose: (index: number) => void;
  onHover: (index: number) => void;
}

/** Two sections, skills then agents; `entries` is already in that order. */
export function SlashMenuList({ entries, active, listId, onChoose, onHover }: SlashMenuListProps) {
  const { t } = useChatHost();
  const firstAgent = entries.findIndex((entry) => entry.kind === "agent");
  const sections = [
    {
      key: "skills",
      heading: t("slash.skills"),
      from: 0,
      to: firstAgent === -1 ? entries.length : firstAgent,
    },
    { key: "agents", heading: t("slash.agents"), from: firstAgent, to: entries.length },
  ].filter((section) => section.from !== -1 && section.to > section.from);
  return (
    <div
      data-testid="slash-menu"
      className="bg-popover text-popover-foreground absolute inset-x-0 bottom-full z-30 mb-2 max-h-72 overflow-y-auto overscroll-contain rounded-xl border p-1 shadow-md"
    >
      <div role="listbox" id={listId} aria-label={t("slash.label")}>
        {sections.map((section) => (
          <div key={section.key} role="group" aria-labelledby={`${listId}-${section.key}`}>
            <div
              id={`${listId}-${section.key}`}
              role="presentation"
              className="text-muted-foreground px-2 py-1.5 text-xs font-medium"
            >
              {section.heading}
            </div>
            {entries.slice(section.from, section.to).map((entry, offset) => {
              const index = section.from + offset;
              return (
                <SlashOption
                  key={entry.kind === "skill" ? entry.skill.id : entry.agent.name}
                  entry={entry}
                  id={optionId(listId, index)}
                  active={index === active}
                  onChoose={() => onChoose(index)}
                  onHover={() => onHover(index)}
                />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function SlashOption({
  entry,
  id,
  active,
  onChoose,
  onHover,
}: {
  entry: SlashEntry;
  id: string;
  active: boolean;
  onChoose: () => void;
  onHover: () => void;
}) {
  const { t } = useChatHost();
  const capped = entry.kind === "skill" && entry.state === "capped";
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      aria-disabled={capped || undefined}
      data-kind={entry.kind}
      className={cn(
        "desktop-pointer:min-h-9 flex min-h-10 cursor-pointer items-start gap-2 rounded-md px-2 py-1.5",
        active && "bg-accent text-accent-foreground",
        capped && "cursor-default opacity-50",
      )}
      // The input keeps the focus: a click must not take it.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onChoose}
      onMouseMove={onHover}
    >
      {entry.kind === "skill" ? (
        <>
          <BookOpenIcon className="text-muted-foreground mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline gap-1.5">
              <span className="truncate text-sm font-medium">{entry.skill.name}</span>
              {entry.skill.version && (
                <span className="text-muted-foreground shrink-0 text-xs">
                  v{entry.skill.version}
                </span>
              )}
            </span>
            <span className="text-muted-foreground line-clamp-1 block text-xs">
              {capped ? t("skills.chosenMax", { max: MAX_PINNED_SKILLS }) : entry.skill.description}
            </span>
          </span>
          {entry.state === "pinned" && (
            <>
              <CheckIcon className="text-primary mt-0.5 size-4 shrink-0" />
              <span className="sr-only">{t("slash.pinned")}</span>
            </>
          )}
        </>
      ) : (
        <>
          <BotIcon className="text-muted-foreground mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{entry.agent.title}</span>
            <span className="text-muted-foreground line-clamp-1 block text-xs">
              {entry.agent.description}
            </span>
          </span>
          <Badge variant="outline" className="shrink-0 font-normal">
            {t("slash.agentRun")}
          </Badge>
        </>
      )}
    </div>
  );
}
