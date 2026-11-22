// SPDX-License-Identifier: Apache-2.0

// Skill picker: the conversation's chosen skills and the discovery switch. Controlled;
// nothing is written here — the next turn carries the selection.

import type { ReactNode } from "react";
import { LockIcon } from "lucide-react";
import { Checkbox } from "@appstrate/ui/components/checkbox";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { Switch } from "@appstrate/ui/components/switch";
import { Popover, PopoverAnchor, PopoverContent } from "@appstrate/ui/components/popover";
import { cn } from "@appstrate/ui/cn";
import { MAX_PINNED_SKILLS, type ChatSkillSelection } from "../skills.ts";
import { effectiveSkills, skillPickerRows, togglePinned } from "./chat-skills.ts";
import { useChatCommands } from "./use-chat-commands.ts";
import { RemovableChip } from "./removable-chip.tsx";
import { useChatHost, type ChatTransport } from "./runtime-context.ts";

const NO_CITED: readonly string[] = [];

interface SkillsPickerProps {
  transport: ChatTransport | undefined;
  selection: ChatSkillSelection;
  onChange: (selection: ChatSkillSelection) => void;
  /** Opened from the composer's settings menu or a skills chip, never by a trigger of its own. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The skills the composer's draft cites: checked here, and held by the message, not the panel. */
  cited?: readonly string[];
  /** The popover anchors to this: the composer's tools row. */
  children: ReactNode;
}

/**
 * The entry to the picker in the composer's tool row while no skill is pinned (drawn by
 * `SkillChips`): drawn only with discovery off, it reopens the picker, and its X restores the
 * default selection.
 */
export function SkillsChip({
  selection,
  onClick,
  onReset,
}: {
  selection: ChatSkillSelection;
  onClick: () => void;
  onReset: () => void;
}) {
  const { t } = useChatHost();
  if (selection.skillDiscovery) return null;
  return (
    <RemovableChip
      icon={<LockIcon />}
      open={{ onClick, label: t("skills.discoveryOffChip"), testId: "skills-picker-trigger" }}
      removeLabel={t("skills.reset")}
      onRemove={onReset}
      className="shrink-0"
    >
      {t("skills.discoveryOffChip")}
    </RemovableChip>
  );
}

/** The popover's body: the discovery switch and the skill list. Exported to be rendered without the popover's portal. */
export function SkillsPickerPanel({
  transport,
  selection,
  onChange,
  cited = NO_CITED,
}: Pick<SkillsPickerProps, "transport" | "selection" | "onChange" | "cited">) {
  const { t } = useChatHost();
  const catalogue = useChatCommands(transport, true);
  const skills = catalogue.data?.skills ?? [];
  // `isLoading`, not `isPending`: a disabled query stays pending forever, and unreadable reads
  // as "nothing".
  const loading = catalogue.isLoading;

  const pinned = selection.pinnedSkills;
  const effective = effectiveSkills(pinned, cited);
  const pinnedSet = new Set(effective.ids);
  const atPinCap = effective.atCap;
  const rows = skillPickerRows(skills, effective.ids);

  const togglePin = (packageId: string) => {
    // A cited skill is the message's: only removing its chip drops it.
    if (effective.cited.has(packageId)) return;
    onChange({ ...selection, pinnedSkills: togglePinned(pinned, packageId) });
  };

  return (
    <>
      <p className="shrink-0 text-sm font-medium">{t("skills.title")}</p>

      <div className="mt-2 flex shrink-0 items-center justify-between gap-3 px-1">
        <label htmlFor="skills-discovery" className="cursor-pointer text-xs font-medium">
          {t("skills.discovery.label")}
        </label>
        <Switch
          id="skills-discovery"
          data-testid="skills-discovery"
          checked={selection.skillDiscovery}
          onCheckedChange={(skillDiscovery) => onChange({ ...selection, skillDiscovery })}
        />
      </div>
      <p className="text-muted-foreground mt-1.5 shrink-0 px-1 text-[0.7rem] leading-snug">
        {t(selection.skillDiscovery ? "skills.discovery.hintOn" : "skills.discovery.hintOff")}
      </p>

      <div className="mt-3 min-h-0 flex-1 overflow-y-auto border-t pt-2">
        <div className="text-muted-foreground px-1 py-1 text-[0.65rem] font-semibold tracking-wider uppercase">
          {t("skills.chooseHeading")}
        </div>
        {atPinCap && (
          <p className="text-muted-foreground px-1 pb-1 text-[0.7rem] leading-snug">
            {t("skills.chosenMax", { max: MAX_PINNED_SKILLS })}
          </p>
        )}
        {loading ? (
          <div role="status" aria-busy="true" aria-label={t("skills.loading")}>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex items-start gap-2 rounded-md p-1">
                <Skeleton className="mt-0.5 size-4 shrink-0 rounded-sm" />
                <Skeleton className="mt-1 h-3 w-2/3" />
              </div>
            ))}
          </div>
        ) : catalogue.isError ? (
          <p className="text-destructive px-1 py-3 text-center text-xs">{t("skills.error")}</p>
        ) : rows.length === 0 ? (
          <p className="text-muted-foreground px-1 py-3 text-center text-xs">{t("skills.empty")}</p>
        ) : (
          rows.map(({ skill, available }, index) => {
            // By row: a package id's `@` and `/` break selectors, and a slug
            // of it can collide (`@a-b/c`, `@a/b-c`).
            const id = `skills-pin-${index}`;
            const checked = pinnedSet.has(skill.id);
            const isCited = effective.cited.has(skill.id);
            const inert = (!checked && atPinCap) || isCited;
            return (
              <div key={skill.id} className="flex items-start gap-2 rounded-md p-1">
                <Checkbox
                  id={id}
                  data-testid={`skill-pin-${skill.id}`}
                  checked={checked}
                  disabled={inert}
                  data-cited={isCited || undefined}
                  onCheckedChange={() => togglePin(skill.id)}
                  className="mt-0.5 shrink-0"
                />
                <label
                  htmlFor={id}
                  className={cn("min-w-0 flex-1 cursor-pointer", inert && "opacity-50")}
                >
                  <span className="flex items-baseline gap-1.5">
                    <span className="truncate text-xs font-medium">{skill.name}</span>
                    {skill.version && (
                      <span className="text-muted-foreground shrink-0 text-[0.65rem]">
                        v{skill.version}
                      </span>
                    )}
                  </span>
                  {isCited && (
                    <span className="text-muted-foreground block text-[0.7rem] leading-snug">
                      {t("skills.cited")}
                    </span>
                  )}
                  {available ? (
                    skill.description && (
                      <span className="text-muted-foreground line-clamp-2 text-[0.7rem] leading-snug">
                        {skill.description}
                      </span>
                    )
                  ) : (
                    <span className="text-muted-foreground text-[0.7rem] leading-snug italic">
                      {t("skills.unavailable")}
                    </span>
                  )}
                </label>
              </div>
            );
          })
        )}
      </div>
    </>
  );
}

export function SkillsPicker({
  transport,
  selection,
  onChange,
  open,
  onOpenChange,
  cited,
  children,
}: SkillsPickerProps) {
  const { t } = useChatHost();
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>{children}</PopoverAnchor>

      <PopoverContent
        side="top"
        align="start"
        sideOffset={6}
        collisionPadding={12}
        aria-label={t("skills.title")}
        data-testid="skills-picker-popover"
        className="flex max-h-[min(26rem,var(--radix-popover-content-available-height))] w-[min(23rem,calc(100vw-1.5rem))] flex-col p-3"
      >
        <SkillsPickerPanel
          transport={transport}
          selection={selection}
          onChange={onChange}
          cited={cited}
        />
      </PopoverContent>
    </Popover>
  );
}
