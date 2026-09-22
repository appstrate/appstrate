// SPDX-License-Identifier: Apache-2.0

/**
 * The composer's skill picker: how much of the space's skill catalogue this
 * conversation puts in front of the assistant, and which skills are always
 * there.
 *
 * Two controls, one popover. The discovery mode is a context-budget choice
 * (`auto` | `on_demand` | `manual`) and never an authorization one — an
 * unindexed skill stays readable through the platform's own RBAC-gated
 * `getSkill`. The pins are the user's own override: a pinned skill is indexed
 * in every mode, including `manual`, which indexes nothing else.
 *
 * Both write through `useSessionSkills`, which patches the cache and coalesces
 * the PUTs, so a burst of checkbox clicks costs one settled request per pause.
 */

import { useState } from "react";
import { BookOpenIcon } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Checkbox } from "@appstrate/ui/components/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@appstrate/ui/components/popover";
import { RadioGroup, RadioGroupItem } from "@appstrate/ui/components/radio-group";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@appstrate/ui/components/tooltip";
import { cn } from "@appstrate/ui/cn";
import { MAX_PINNED_SKILLS, SKILL_DISCOVERY_MODES, type SkillDiscovery } from "../skills.ts";
import { groupSkillsBySource, type ChatSkillEntry } from "./chat-skills.ts";
import { useChatHeaders, useChatHost } from "./runtime-context.ts";
import { useChatSkillsCatalog } from "./use-chat-skills.ts";
import { useSessionSkills } from "./use-session-skills.ts";

/**
 * Literal keys, one per mode — never `t(\`skills.discovery.${mode}\`)`. The
 * locale gate resolves call sites statically, and an interpolated key would
 * need an exemption entry for what is a fixed three-member set.
 */
const MODE_KEYS: Record<SkillDiscovery, { label: string; hint: string }> = {
  auto: { label: "skills.discovery.auto", hint: "skills.discovery.autoHint" },
  on_demand: { label: "skills.discovery.onDemand", hint: "skills.discovery.onDemandHint" },
  manual: { label: "skills.discovery.manual", hint: "skills.discovery.manualHint" },
};

const GROUP_KEYS: Record<ChatSkillEntry["source"], string> = {
  platform: "skills.group.platform",
  space: "skills.group.space",
};

/**
 * A package id as a DOM id fragment: `@acme/x` → `-acme-x`. The raw id puts `@`
 * and `/` in an `id`/`htmlFor` pair — legal in HTML5, but unusable from a CSS
 * selector without escaping, so anything reaching for one (a test, a style)
 * breaks on it rather than on the id it meant.
 */
function domIdPart(packageId: string): string {
  return packageId.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

export function SkillsPicker({ sessionId }: { sessionId: string }) {
  const { t } = useChatHost();
  const getHeaders = useChatHeaders();
  const [open, setOpen] = useState(false);
  const { discovery, pinned, setDiscovery, togglePin, atPinCap } = useSessionSkills(
    sessionId,
    getHeaders,
  );
  const { skills, loading, failed } = useChatSkillsCatalog();
  const groups = groupSkillsBySource(skills);
  const pinnedSet = new Set(pinned);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                // The count is painted as a badge; a screen reader gets it here
                // or not at all.
                aria-label={
                  pinned.length > 0
                    ? t("skills.labelCount", { n: pinned.length })
                    : t("skills.label")
                }
                className={cn(
                  "relative size-8 shrink-0 rounded-lg",
                  pinned.length > 0 ? "text-primary hover:text-primary" : "text-muted-foreground",
                )}
              >
                <BookOpenIcon />
                {pinned.length > 0 && (
                  <span
                    aria-hidden="true"
                    className="bg-primary text-primary-foreground absolute -top-0.5 -right-0.5 flex min-w-4 items-center justify-center rounded-full px-1 text-[0.6rem] leading-4 font-medium"
                  >
                    {pinned.length}
                  </span>
                )}
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-72 text-xs">
            <p className="font-medium">{t("skills.title")}</p>
            {pinned.length > 0 && (
              <p className="text-muted-foreground mt-0.5">
                {t("skills.pinned", { n: pinned.length })}
              </p>
            )}
            {/* The `/` mention is the other half of this feature and has no
                affordance of its own — the composer cannot advertise a
                character. This tooltip is where a user finds out. */}
            <p className="text-muted-foreground mt-0.5">{t("skills.mention.hint")}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <PopoverContent
        side="top"
        align="start"
        sideOffset={6}
        collisionPadding={12}
        aria-label={t("skills.title")}
        className="flex max-h-[min(26rem,var(--radix-popover-content-available-height))] w-[min(23rem,calc(100vw-1.5rem))] flex-col p-3"
      >
        <p className="shrink-0 text-sm font-medium">{t("skills.title")}</p>

        <div className="mt-2 shrink-0">
          <div className="text-muted-foreground px-1 py-1 text-[0.65rem] font-semibold tracking-wider uppercase">
            {t("skills.discovery.label")}
          </div>
          {/* Radix gives the group `role="radiogroup"`; the heading above is a
              plain div, so the name has to be stated rather than inferred. */}
          <RadioGroup
            value={discovery}
            onValueChange={(value) => setDiscovery(value as SkillDiscovery)}
            aria-label={t("skills.discovery.label")}
            className="mt-0.5 gap-1.5"
          >
            {SKILL_DISCOVERY_MODES.map((mode) => (
              <div key={mode} className="flex items-start gap-2">
                <RadioGroupItem value={mode} id={`skills-mode-${mode}`} className="mt-0.5" />
                <label htmlFor={`skills-mode-${mode}`} className="min-w-0 cursor-pointer">
                  <span className="block text-xs font-medium">{t(MODE_KEYS[mode].label)}</span>
                  {/* One hint at a time — the selected mode's — so the list below
                      keeps the room; the other two are one click away. */}
                  {mode === discovery && (
                    <span className="text-muted-foreground block text-[0.7rem] leading-snug">
                      {t(MODE_KEYS[mode].hint)}
                    </span>
                  )}
                </label>
              </div>
            ))}
          </RadioGroup>
        </div>

        {/* The cap is the server's (`MAX_PINNED_SKILLS`); a refused 21st pin is
            otherwise a checkbox that simply does not tick. */}
        {atPinCap && (
          <p className="text-muted-foreground mt-2 shrink-0 px-1 text-[0.7rem] leading-snug">
            {t("skills.pinnedMax", { max: MAX_PINNED_SKILLS })}
          </p>
        )}

        <div className="mt-3 min-h-0 flex-1 overflow-y-auto border-t pt-2">
          {loading ? (
            <p className="text-muted-foreground px-1 py-3 text-center text-xs">
              {t("skills.loading")}
            </p>
          ) : failed ? (
            <p className="text-destructive px-1 py-3 text-center text-xs">{t("skills.error")}</p>
          ) : groups.length === 0 ? (
            <p className="text-muted-foreground px-1 py-3 text-center text-xs">
              {t("skills.empty")}
            </p>
          ) : (
            groups.map((group, i) => (
              <div key={group.source} className={i > 0 ? "mt-2 border-t pt-2" : undefined}>
                <div className="text-muted-foreground px-1 py-1 text-[0.65rem] font-semibold tracking-wider uppercase">
                  {t(GROUP_KEYS[group.source])}
                </div>
                {group.skills.map((skill) => {
                  const id = `skills-pin-${domIdPart(skill.package_id)}`;
                  const checked = pinnedSet.has(skill.package_id);
                  return (
                    <div key={skill.package_id} className="flex items-start gap-2 rounded-md p-1">
                      <Checkbox
                        id={id}
                        checked={checked}
                        disabled={!checked && atPinCap}
                        onCheckedChange={() => togglePin(skill.package_id)}
                        className="mt-0.5 shrink-0"
                      />
                      <label
                        htmlFor={id}
                        className={cn(
                          "min-w-0 flex-1 cursor-pointer",
                          !checked && atPinCap && "opacity-50",
                        )}
                      >
                        <span className="flex items-baseline gap-1.5">
                          <span className="truncate text-xs font-medium">
                            {skill.display_name || skill.package_id}
                          </span>
                          {skill.version && (
                            <span className="text-muted-foreground shrink-0 text-[0.65rem]">
                              v{skill.version}
                            </span>
                          )}
                        </span>
                        <span className="text-muted-foreground line-clamp-2 text-[0.7rem] leading-snug">
                          {skill.description}
                        </span>
                      </label>
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
