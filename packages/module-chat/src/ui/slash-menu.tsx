// SPDX-License-Identifier: Apache-2.0

/**
 * The composer's `/` menu: a listbox above the composer card, driven from the input (which keeps
 * the focus, `aria-activedescendant` names the active option). The rules are in `slash-menu.ts`,
 * the state in `use-slash-menu.ts`.
 */

import { useEffect, useRef } from "react";
import { BookOpenIcon, BotIcon, CheckIcon } from "lucide-react";
import { cn } from "@appstrate/ui/cn";
import { MAX_PINNED_SKILLS } from "../skills.ts";
import { useChatHost } from "./runtime-context.ts";
import type { SlashEntry } from "./slash-menu.ts";
import { optionId, type SlashStatus } from "./use-slash-menu.ts";

interface SlashMenuListProps {
  entries: readonly SlashEntry[];
  status?: SlashStatus;
  /** The last pin was refused at the cap: said politely to assistive technology. */
  refused?: boolean;
  active: number;
  listId: string;
  onChoose: (index: number) => void;
  onHover: (index: number) => void;
}

/** Two sections, skills then agents; `entries` is already in that order. */
export function SlashMenuList({
  entries,
  status = "ready",
  refused = false,
  active,
  listId,
  onChoose,
  onHover,
}: SlashMenuListProps) {
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
  // Two listed skills of one name: their package id tells them apart.
  const names = entries.flatMap((entry) => (entry.kind === "skill" ? [entry.skill.name] : []));
  const homonyms = new Set(names.filter((name, i) => names.indexOf(name) !== i));
  return (
    <div
      data-testid="slash-menu"
      className="bg-popover text-popover-foreground absolute inset-x-0 bottom-full z-30 mb-2 max-h-72 overflow-y-auto overscroll-contain rounded-xl border p-1 shadow-md"
    >
      <div role="status" className="sr-only">
        {refused ? t("skills.chosenMax", { max: MAX_PINNED_SKILLS }) : ""}
      </div>
      {entries.length === 0 && status === "loading" && (
        <p role="status" className="text-muted-foreground px-2 py-2 text-sm">
          {t("slash.loading")}
        </p>
      )}
      {entries.length === 0 && status === "error" && (
        <p role="alert" className="text-destructive px-2 py-2 text-sm">
          {t("slash.error")}
        </p>
      )}
      {entries.length > 0 && (
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
                    homonym={entry.kind === "skill" && homonyms.has(entry.skill.name)}
                    onChoose={() => onChoose(index)}
                    onHover={() => onHover(index)}
                  />
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SlashOption({
  entry,
  id,
  active,
  homonym,
  onChoose,
  onHover,
}: {
  entry: SlashEntry;
  id: string;
  active: boolean;
  homonym: boolean;
  onChoose: () => void;
  onHover: () => void;
}) {
  const { t } = useChatHost();
  const capped = entry.kind === "skill" && entry.state === "capped";
  const ref = useRef<HTMLDivElement>(null);
  // The list scrolls: the arrow keys must not move the active option out of sight.
  useEffect(() => {
    if (active) ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [active]);
  return (
    <div
      ref={ref}
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
              {homonym && (
                <span className="text-muted-foreground truncate text-xs">{entry.skill.id}</span>
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
          <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
            <span className="truncate text-sm font-medium">{entry.agent.title}</span>
            <span className="text-muted-foreground shrink-0 text-xs">/{entry.agent.name}</span>
          </span>
        </>
      )}
    </div>
  );
}
