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
import { canComposeInlineRuns } from "../capabilities.ts";
import type { ChatSkillSelection } from "../skills.ts";
import {
  limitAvailability,
  useAttachTarget,
  useConversationScope,
  useOriginSpaceLabel,
  useOriginSpaceNode,
  useSpaceLabel,
  useSpaceNode,
  type AttachUnavailableReason,
  type LimitUnavailableReason,
} from "./conversation-scope.ts";
import {
  setPackageAuthoringEnabled,
  usePackageAuthoringEnabled,
} from "./package-authoring-store.ts";
import { setInlineRunModelEnabled, useInlineRunModelEnabled } from "./inline-run-model-store.ts";
import { useChatHost, useChatTransport, type ChatTransport } from "./runtime-context.ts";
import { RemovableChip } from "./removable-chip.tsx";
import { sentenceWithNode } from "./sentence-with-name.tsx";
import { SkillChips } from "./skill-chips.tsx";
import { SkillsPicker } from "./skills-picker.tsx";

const ICON_BUTTON = "text-muted-foreground size-8 shrink-0 rounded-lg";

const LIMIT_REASON_KEY: Record<LimitUnavailableReason, string> = {
  generating: "composer.limit.generating",
  "no-acting-space": "composer.limit.noActingSpace",
  outside: "composer.limit.outside",
};

const ATTACH_REASON_KEY: Record<AttachUnavailableReason, string> = {
  outside: "composer.attachUnavailable",
  "origin-outside": "composer.limit.outside",
  "no-acting-space": "composer.limit.noActingSpace",
};

export interface ComposerToolsProps {
  transport: ChatTransport | undefined;
  selection: ChatSkillSelection;
  onSelectionChange: (selection: ChatSkillSelection) => void;
  /** The skills picker is offered (`skills:read` + a readable conversation). */
  showPicker: boolean;
  /** The caller may author packages: the creation-mode switch is offered. */
  authorsPackages: boolean;
}

export function ComposerTools({
  transport,
  selection,
  onSelectionChange,
  showPicker,
  authorsPackages,
}: ComposerToolsProps) {
  const { t, can } = useChatHost();
  const scope = useConversationScope();
  // The origin's plain name, for the accessible names: the node below carries a tile the name
  // does not. Without an origin, the sentence stays generic.
  const spaceLabel = useOriginSpaceLabel();
  const spaceNode = useOriginSpaceNode();
  const creationMode = usePackageAuthoringEnabled();
  // Composing an inline run needs creation mode too: off, no turn launches one.
  const offersInlineRunModel = creationMode && canComposeInlineRuns(can);
  const inlineRunModel = useInlineRunModelEnabled();
  const [skillsOpen, setSkillsOpen] = useState(false);
  // A popover opened while the menu is closing loses to the menu's focus
  // restore (Radix reads it as a focus-outside): open it once the menu is gone.
  const openSkillsAfterClose = useRef(false);

  const cluster = (
    <div className="flex min-w-0 items-center gap-1.5">
      <AttachButton />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={ICON_BUTTON}
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
          removeLabel={t("composer.limit.undo", { name: spaceLabel })}
          removeDisabled={scope.generating || scope.pending}
          onRemove={scope.lift}
          data-testid="composer-limit-chip"
        >
          {sentenceWithNode(t, "composer.limitChip", spaceNode)}
        </RemovableChip>
      )}
      {showPicker && (
        <SkillChips
          transport={transport}
          selection={selection}
          onOpenPicker={() => setSkillsOpen(true)}
          onResetMode={() => onSelectionChange({ ...selection, skillMode: "auto" })}
        />
      )}
    </div>
  );

  if (!showPicker) return cluster;
  return (
    <SkillsPicker
      transport={transport}
      selection={selection}
      onChange={onSelectionChange}
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
  const spaceLabel = useSpaceLabel(named);
  const spaceNode = useSpaceNode(named);
  return limit.kind === "toggle" ? (
    // The origin, or the one space the chat acts in: one click limits there.
    <DropdownMenuCheckboxItem
      checked={scope.restricted}
      disabled={scope.pending}
      onCheckedChange={(on) => (on ? scope.limitTo(limit.spaceId) : scope.lift())}
      aria-label={t("composer.limit", { name: spaceLabel })}
      data-testid="composer-limit-item"
    >
      {sentenceWithNode(t, "composer.limit", spaceNode)}
    </DropdownMenuCheckboxItem>
  ) : limit.kind === "choose" ? (
    // No origin and several acting spaces: the space picked becomes the origin.
    <SpaceChoiceMenu
      variant="submenu"
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
    <UnavailableItem
      icon={<MapPinIcon />}
      label={t("composer.limit.generic")}
      reason={limit.reason && t(LIMIT_REASON_KEY[limit.reason])}
      testId="composer-limit-item"
    />
  );
}

/** A menu item that cannot be chosen here, with the reason under its label when there is one. */
function UnavailableItem({
  icon,
  label,
  reason,
  testId,
}: {
  icon: ReactNode;
  label: ReactNode;
  reason: ReactNode;
  testId: string;
}) {
  return (
    <DropdownMenuItem disabled data-testid={testId}>
      {icon}
      <LabelWithHint label={label} hint={reason} />
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

/** The attach button opens the native picker directly, or after choosing its destination. */
function AttachButton() {
  const { t, SpaceChoiceMenu } = useChatHost();
  const shownSpaceId = useChatTransport()?.spaceId ?? null;
  const { availability, pick } = useAttachTarget();
  const filePicker = useRef<HTMLButtonElement>(null);
  const spaceLabel = useSpaceLabel(availability.kind === "attach" ? availability.spaceId : null);
  const label =
    availability.kind === "attach" && availability.spaceId !== shownSpaceId
      ? t("composer.attachIn", { name: spaceLabel })
      : t("composer.attach");
  const unavailable = availability.kind === "unavailable";
  const button = (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      disabled={unavailable}
      className={ICON_BUTTON}
      aria-label={label}
    >
      <PaperclipIcon />
    </Button>
  );
  if (availability.kind === "attach") {
    return <ComposerPrimitive.AddAttachment asChild>{button}</ComposerPrimitive.AddAttachment>;
  }
  if (availability.kind === "choose") {
    return (
      <>
        <SpaceChoiceMenu
          variant="dropdown"
          label={t("composer.attach.choose")}
          spaceIds={availability.spaceIds}
          onPick={(spaceId) => {
            pick(spaceId);
            filePicker.current?.click();
          }}
          trigger={button}
        />
        <ComposerPrimitive.AddAttachment hidden ref={filePicker} />
      </>
    );
  }
  if (!availability.reason) return button;
  const reason = t(ATTACH_REASON_KEY[availability.reason]);
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
