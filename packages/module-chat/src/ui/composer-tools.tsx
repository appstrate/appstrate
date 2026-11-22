// SPDX-License-Identifier: Apache-2.0

/**
 * The composer's left cluster: an attach button, a settings menu (skills, space limit, creation
 * mode, inline-run model) and, after them, a removable chip for each non-default setting that is
 * active. Settings live behind the menu, so the composer shows only what differs from the defaults.
 */

import { useRef, useState, type ReactNode } from "react";
import { ComposerPrimitive } from "@assistant-ui/react";
import {
  BookOpenIcon,
  CpuIcon,
  MapPinIcon,
  PackageIcon,
  PaperclipIcon,
  SettingsIcon,
} from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@appstrate/ui/components/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@appstrate/ui/components/tooltip";
import { attachUnavailableKey } from "./attachment-adapter.ts";
import { canComposeInlineRuns } from "../capabilities.ts";
import type { ConversationSkills } from "./chat-skills.ts";
import type { SkillActions } from "./use-conversation-skills.ts";
import {
  limitAvailability,
  useConversationScope,
  useSpaceName,
  type LimitUnavailableReason,
} from "./conversation-scope.ts";
import {
  setPackageAuthoringEnabled,
  usePackageAuthoringEnabled,
} from "./package-authoring-store.ts";
import { setInlineRunModelEnabled, useInlineRunModelEnabled } from "./inline-run-model-store.ts";
import { useChatHost, type ChatTransport } from "./runtime-context.ts";
import { RemovableChip } from "./removable-chip.tsx";
import { sentenceWithNode } from "./sentence-with-name.tsx";
import { SkillChips } from "./skill-chips.tsx";
import { useCitedSkills } from "./pinned-skills.ts";
import { SkillsPicker } from "./skills-picker.tsx";
import { COMPOSER_TOOL_BUTTON_CLASS } from "./touch-targets.ts";

const LIMIT_REASON_KEY: Record<LimitUnavailableReason, string> = {
  generating: "composer.limit.generating",
  "no-acting-space": "composer.limit.noActingSpace",
  outside: "composer.limit.outside",
};

export interface ComposerToolsProps {
  transport: ChatTransport | undefined;
  skills: ConversationSkills;
  skillActions: SkillActions;
  /** The skills picker is offered (`skills:read` + a readable conversation). */
  showPicker: boolean;
  /** The caller may author packages: the creation-mode switch is offered. */
  authorsPackages: boolean;
}

export function ComposerTools({
  transport,
  skills,
  skillActions,
  showPicker,
  authorsPackages,
}: ComposerToolsProps) {
  const { t, can } = useChatHost();
  const cited = useCitedSkills();
  const scope = useConversationScope();
  const origin = useSpaceName(scope.originSpaceId);
  const creationMode = usePackageAuthoringEnabled();
  // Composing an inline run needs creation mode too: off, no turn launches one.
  const offersInlineRunModel = creationMode && canComposeInlineRuns(can);
  const inlineRunModel = useInlineRunModelEnabled();
  const [skillsOpen, setSkillsOpen] = useState(false);
  // A popover opened while the menu is closing loses to the menu's focus
  // restore (Radix reads it as a focus-outside): open it once the menu is gone.
  const openSkillsAfterClose = useRef(false);

  // A phone's resting composer is one line, attach and send around the field: every tool after the
  // attach button shows once the composer is touched (`data-rest` is the composer's).
  const cluster = (
    <div className="flex min-w-0 items-center gap-1.5 max-md:flex-wrap max-md:group-data-[rest]/composer:[&>:not(:first-child)]:hidden">
      <AttachButton />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={COMPOSER_TOOL_BUTTON_CLASS}
            aria-label={t("composer.settings")}
            data-testid="composer-settings-trigger"
          >
            <SettingsIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="top"
          align="start"
          onCloseAutoFocus={(event) => {
            if (!openSkillsAfterClose.current) return;
            event.preventDefault();
            openSkillsAfterClose.current = false;
            setSkillsOpen(true);
          }}
        >
          {showPicker && (
            <DropdownMenuItem
              onSelect={() => {
                openSkillsAfterClose.current = true;
              }}
            >
              <BookOpenIcon />
              {t("composer.skills")}
            </DropdownMenuItem>
          )}
          <LimitMenuEntry />
          {authorsPackages && (
            <DropdownMenuCheckboxItem
              checked={creationMode}
              onCheckedChange={setPackageAuthoringEnabled}
            >
              {/* The check mark takes the icon column, as Radix lays it out. */}
              {t("composer.creationMode")}
            </DropdownMenuCheckboxItem>
          )}
          {offersInlineRunModel && (
            <DropdownMenuCheckboxItem
              checked={inlineRunModel}
              onCheckedChange={setInlineRunModelEnabled}
              // The hint below would otherwise be read as part of the name.
              aria-label={t("composer.inlineRunModel")}
              data-testid="composer-inline-run-model-item"
            >
              <LabelWithHint
                label={t("composer.inlineRunModel")}
                hint={t("composer.inlineRunModel.hint")}
              />
            </DropdownMenuCheckboxItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* On is the default, so the chip marks the departure from it: an author
          who turned creation off sees it, and its X turns creation back on. */}
      {authorsPackages && !creationMode && (
        <RemovableChip
          icon={<PackageIcon />}
          removeLabel={t("composer.creationOff.undo")}
          onRemove={() => setPackageAuthoringEnabled(true)}
        >
          {t("composer.creationOff")}
        </RemovableChip>
      )}
      {/* Off is the default, so the chip marks the departure from it. */}
      {offersInlineRunModel && inlineRunModel && (
        <RemovableChip
          icon={<CpuIcon />}
          removeLabel={t("composer.inlineRunModelChip.undo")}
          onRemove={() => setInlineRunModelEnabled(false)}
          data-testid="composer-inline-run-model-chip"
        >
          {t("composer.inlineRunModelChip")}
        </RemovableChip>
      )}
      {scope.restricted && (
        <RemovableChip
          icon={<MapPinIcon />}
          removeLabel={
            origin
              ? t("composer.limit.undo", { name: origin.label })
              : t("composer.limit.undoGeneric")
          }
          removeDisabled={scope.generating || scope.pending}
          onRemove={scope.lift}
          data-testid="composer-limit-chip"
        >
          {origin
            ? sentenceWithNode(t, "composer.limitChip", origin.node)
            : t("composer.limitChip.generic")}
        </RemovableChip>
      )}
      {showPicker && (
        <SkillChips
          transport={transport}
          skills={skills}
          cited={cited}
          onOpenPicker={() => setSkillsOpen(true)}
          onReset={skillActions.reset}
        />
      )}
    </div>
  );

  if (!showPicker) return cluster;
  return (
    <SkillsPicker
      transport={transport}
      skills={skills}
      actions={skillActions}
      cited={cited}
      open={skillsOpen}
      onOpenChange={setSkillsOpen}
    >
      {cluster}
    </SkillsPicker>
  );
}

/**
 * The settings menu's limit entry, as {@link limitAvailability} decides: one click limiting to the
 * space it names, the host's sub-menu of the acting spaces for a conversation without an origin,
 * or an inert entry giving the reason.
 */
export function LimitMenuEntry() {
  const { t, actingSpaceIds, SpaceChoiceMenu } = useChatHost();
  const scope = useConversationScope();
  const limit = limitAvailability(scope, actingSpaceIds);
  // The space a click limits to: the origin, or the one acting space.
  const named = limit.kind === "toggle" ? limit.spaceId : null;
  const space = useSpaceName(named);
  return limit.kind === "toggle" ? (
    // The origin, or the one space the chat acts in: one click limits there.
    <DropdownMenuCheckboxItem
      checked={scope.restricted}
      disabled={scope.pending}
      onCheckedChange={(on) => (on ? scope.limitTo(limit.spaceId) : scope.lift())}
      aria-label={space ? t("composer.limit", { name: space.label }) : t("composer.limit.generic")}
      data-testid="composer-limit-item"
    >
      {space ? sentenceWithNode(t, "composer.limit", space.node) : t("composer.limit.generic")}
    </DropdownMenuCheckboxItem>
  ) : limit.kind === "choose" ? (
    // No origin and several acting spaces: the space picked becomes the origin.
    <SpaceChoiceMenu
      label={t("composer.limit.choose")}
      spaceIds={limit.spaceIds}
      onPick={scope.limitTo}
      trigger={
        <>
          <MapPinIcon />
          {t("composer.limit.generic")}
        </>
      }
      testId="composer-limit-item"
    />
  ) : (
    // A turn generating, no space to act in, an origin the chat no longer acts in, or the
    // acting set not known yet (no reason then).
    <DropdownMenuItem disabled data-testid="composer-limit-item">
      <MapPinIcon />
      <LabelWithHint
        label={t("composer.limit.generic")}
        hint={limit.reason && t(LIMIT_REASON_KEY[limit.reason])}
      />
    </DropdownMenuItem>
  );
}

/** A menu item's label with a line of explanation under it. */
function LabelWithHint({ label, hint }: { label: ReactNode; hint: ReactNode }) {
  return (
    <span className="flex flex-col">
      {label}
      <span className="text-muted-foreground max-w-56 text-xs whitespace-normal">{hint}</span>
    </span>
  );
}

/** The attach button opens the native picker: files always go to the caller's personal space. */
function AttachButton() {
  const { t, attachTarget } = useChatHost();
  const label = t("composer.attach");
  const button = (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      disabled={"unavailable" in attachTarget}
      className={COMPOSER_TOOL_BUTTON_CLASS}
      aria-label={label}
    >
      <PaperclipIcon />
    </Button>
  );
  if ("spaceId" in attachTarget) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <ComposerPrimitive.AddAttachment asChild>{button}</ComposerPrimitive.AddAttachment>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-64 text-xs">
          {t("composer.attachHint")}
        </TooltipContent>
      </Tooltip>
    );
  }
  const reason = t(attachUnavailableKey(attachTarget.unavailable));
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="inline-flex shrink-0">
          {button}
          <span className="sr-only">{reason}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-64 text-xs">
        {reason}
      </TooltipContent>
    </Tooltip>
  );
}
