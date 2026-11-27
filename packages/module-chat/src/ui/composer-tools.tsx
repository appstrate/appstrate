// SPDX-License-Identifier: Apache-2.0

/**
 * The composer's left cluster from `md` up: an attach button, the settings button that opens the
 * tools panel (`ComposerToolsPanel`), and a chip for each setting off its default
 * (`useComposerDepartures`): a chip opens the panel at the level that changes it, its X restores
 * the default. Below `md` ONE "+" at the left of the field opens the same panel, as the chats people
 * already use do: nothing else stays beside the field, and the panel names each setting off its
 * default (`ComposerPlusButton`). The panel is one `Popover`: a sheet from
 * the bottom below `md`, by the design system's own rule.
 */

import { useId, useRef, type ReactNode, type Ref } from "react";
import { ComposerPrimitive } from "@assistant-ui/react";
import {
  CpuIcon,
  LayersIcon,
  MapPinIcon,
  PackageIcon,
  PaperclipIcon,
  PlusIcon,
  SettingsIcon,
} from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from "@appstrate/ui/components/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@appstrate/ui/components/tooltip";
import { MENU_TITLE_CLASS, MenuHeading } from "@appstrate/ui/components/sheet-menu";
import { cn } from "@appstrate/ui/cn";
import { attachUnavailableKey } from "./attachment-adapter.ts";
import {
  DEPARTURE_LEVEL,
  useComposerDepartures,
  useComposerPanel,
  useComposerPanelHeading,
  type ComposerDeparture,
} from "./composer-panel.ts";
import { ComposerToolsPanel } from "./composer-tools-panel.tsx";
import { useConversationSkillsContext } from "./use-conversation-skills.ts";
import { useConversationScope, useSpaceName } from "./conversation-scope.ts";
import { setPackageAuthoringEnabled } from "./package-authoring-store.ts";
import { setInlineRunModelEnabled } from "./inline-run-model-store.ts";
import { setContextAllSpacesEnabled } from "./context-all-spaces-store.ts";
import { useChatHost } from "./runtime-context.ts";
import { RemovableChip } from "./removable-chip.tsx";
import { sentenceWithNode } from "./sentence-with-name.tsx";
import { SkillChips } from "./skill-chips.tsx";
import { COMPOSER_BUTTON_CLASS } from "./touch-targets.ts";

const COMPOSER_TOOL_CLASS = cn(COMPOSER_BUTTON_CLASS, "text-muted-foreground");

export interface ComposerToolsProps {
  /** The caller may author packages: the creation-mode switch is offered. */
  authorsPackages: boolean;
}

export function ComposerTools({ authorsPackages }: ComposerToolsProps) {
  const { t } = useChatHost();
  const panel = useComposerPanel();
  const heading = useComposerPanelHeading();
  const departures = useComposerDepartures(authorsPackages);
  const titleId = useId();
  const plus = useRef<HTMLButtonElement>(null);
  return (
    <Popover
      open={panel.open}
      onOpenChange={(open, details) => {
        if (open) return panel.openAt("tools");
        // A level goes up one level on Escape; the top level closes.
        if (details.reason === "escape-key" && heading.back) {
          details.cancel();
          heading.back.onClick();
          return;
        }
        panel.close();
      }}
    >
      {/* From `md` up; a phone has the "+". The popover anchors to the whole row. */}
      {/* A chip's X hands the focus on within this row (`chip-focus.ts`). */}
      <PopoverAnchor
        render={
          <div className="flex min-w-0 items-center gap-1.5 max-md:hidden" data-chip-row="" />
        }
      >
        <AttachButton />
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className={COMPOSER_TOOL_CLASS}
              aria-label={t("composer.tools")}
              data-testid="composer-settings-trigger"
            />
          }
        >
          <SettingsIcon />
        </PopoverTrigger>
        {departures.map((departure) => (
          <DepartureChip
            key={departure}
            departure={departure}
            onOpen={() => panel.openAt(DEPARTURE_LEVEL[departure])}
          />
        ))}
      </PopoverAnchor>
      <ComposerPlusButton ref={plus} />
      <PopoverContent
        side="top"
        align="start"
        sideOffset={6}
        collisionPadding={12}
        aria-labelledby={titleId}
        data-testid="composer-panel"
        // Closing returns focus to the opener on screen: the "+" below `md`, where the
        // registered trigger (the settings button) is hidden.
        finalFocus={() => (plus.current?.offsetParent ? plus.current : true)}
        className="flex max-h-[min(32rem,var(--available-height))] w-[min(22rem,calc(100vw-1.5rem))] flex-col overflow-hidden p-0"
      >
        <MenuHeading back={heading.back}>
          <p id={titleId} className={MENU_TITLE_CLASS}>
            {heading.title}
          </p>
        </MenuHeading>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto py-1">
          <ComposerToolsPanel authorsPackages={authorsPackages} />
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** One departure as a chip: its body opens the panel at its level, its X restores the default. */
function DepartureChip({
  departure,
  onOpen,
}: {
  departure: ComposerDeparture;
  onOpen: () => void;
}): ReactNode {
  const { t } = useChatHost();
  const conversation = useConversationSkillsContext();
  const scope = useConversationScope();
  const origin = useSpaceName(scope.originSpaceId);
  if (departure === "creationOff")
    return (
      <RemovableChip
        icon={<PackageIcon />}
        open={{
          onClick: onOpen,
          label: t("composer.creationOff"),
          testId: "composer-creation-chip",
        }}
        removeLabel={t("composer.creationOff.undo")}
        onRemove={() => setPackageAuthoringEnabled(true)}
      >
        {t("composer.creationOff")}
      </RemovableChip>
    );
  if (departure === "inlineRunModel")
    return (
      <RemovableChip
        icon={<CpuIcon />}
        open={{
          onClick: onOpen,
          label: t("composer.inlineRunModelChip"),
          testId: "composer-inline-run-model-chip",
        }}
        removeLabel={t("composer.inlineRunModelChip.undo")}
        onRemove={() => setInlineRunModelEnabled(false)}
      >
        {t("composer.inlineRunModelChip")}
      </RemovableChip>
    );
  if (departure === "contextAllSpacesOff")
    return (
      <RemovableChip
        icon={<LayersIcon />}
        open={{
          onClick: onOpen,
          label: t("composer.contextAllSpacesOff"),
          testId: "composer-context-all-spaces-off-chip",
        }}
        removeLabel={t("composer.contextAllSpacesOff.undo")}
        onRemove={() => setContextAllSpacesEnabled(true)}
      >
        {t("composer.contextAllSpacesOff")}
      </RemovableChip>
    );
  if (departure === "limit")
    return (
      <RemovableChip
        icon={<MapPinIcon />}
        open={{
          onClick: onOpen,
          label: origin
            ? t("composer.limitChip", { name: origin.label })
            : t("composer.limitChip.generic"),
          testId: "composer-limit-chip",
        }}
        removeLabel={
          origin
            ? t("composer.limit.undo", { name: origin.label })
            : t("composer.limit.undoGeneric")
        }
        removeDisabled={scope.generating || scope.pending}
        onRemove={scope.lift}
      >
        {origin
          ? sentenceWithNode(t, "composer.limitChip", origin.node)
          : t("composer.limitChip.generic")}
      </RemovableChip>
    );
  if (!conversation) return null;
  return (
    <SkillChips skills={conversation.skills} onOpenPicker={onOpen} onReset={conversation.reset} />
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
      size="icon-sm"
      disabled={"unavailable" in attachTarget}
      className={COMPOSER_TOOL_CLASS}
      aria-label={label}
    >
      <PaperclipIcon />
    </Button>
  );
  if ("spaceId" in attachTarget) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <ComposerPrimitive.AddAttachment asChild>{button}</ComposerPrimitive.AddAttachment>
          }
        />
        <TooltipContent side="top" className="max-w-64 text-xs">
          {t("composer.attachHint")}
        </TooltipContent>
      </Tooltip>
    );
  }
  const reason = t(attachUnavailableKey(attachTarget.unavailable));
  return (
    <Tooltip>
      <TooltipTrigger render={<span tabIndex={0} className="inline-flex shrink-0" />}>
        {button}
        <span className="sr-only">{reason}</span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-64 text-xs">
        {reason}
      </TooltipContent>
    </Tooltip>
  );
}

/** The phone's opener of the panel, at the left of the field. */
function ComposerPlusButton({ ref }: { ref: Ref<HTMLButtonElement> }) {
  const { t } = useChatHost();
  const panel = useComposerPanel();
  return (
    <Button
      ref={ref}
      type="button"
      variant="ghost"
      size="icon-sm"
      className={cn(COMPOSER_TOOL_CLASS, "md:hidden")}
      aria-label={t("composer.tools")}
      aria-haspopup="dialog"
      aria-expanded={panel.open}
      data-testid="composer-plus"
      onClick={() => panel.openAt("tools")}
    >
      <PlusIcon />
    </Button>
  );
}
