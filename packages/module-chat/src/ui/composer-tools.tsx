// SPDX-License-Identifier: Apache-2.0

/**
 * The composer's left cluster: an attach button, a settings menu (skills, space limit, creation
 * mode) and, after them, a removable chip for each non-default setting that is active. Settings
 * live behind the menu, so the composer shows only what differs from the defaults.
 */

import { useRef, useState, type ReactNode } from "react";
import { ComposerPrimitive } from "@assistant-ui/react";
import { BookOpenIcon, MapPinIcon, PackageIcon, PaperclipIcon, SettingsIcon } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@appstrate/ui/components/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@appstrate/ui/components/tooltip";
import type { ChatSkillSelection } from "../skills.ts";
import {
  limitAvailability,
  useAttachAvailability,
  useConversationScope,
  useOriginSpaceLabel,
  useOriginSpaceNode,
} from "./conversation-scope.ts";
import {
  setPackageAuthoringEnabled,
  usePackageAuthoringEnabled,
} from "./package-authoring-store.ts";
import { useChatHost, type ChatTransport } from "./runtime-context.ts";
import { RemovableChip } from "./removable-chip.tsx";
import { sentenceWithNode } from "./sentence-with-name.tsx";
import { SkillChips } from "./skill-chips.tsx";
import { SkillsPicker } from "./skills-picker.tsx";

const ICON_BUTTON = "text-muted-foreground size-8 shrink-0 rounded-lg";

const LIMIT_REASON_KEY = {
  generating: "composer.limit.generating",
  "no-space": "composer.limit.noSpace",
  outside: "composer.limit.outside",
} as const;

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
  const { t, actingSpaceIds } = useChatHost();
  const scope = useConversationScope();
  const attach = useAttachAvailability();
  // The plain name, for the accessible names: the node below carries a tile the name does not.
  const spaceLabel = useOriginSpaceLabel();
  const limit = limitAvailability(scope, actingSpaceIds);
  // The space as the host names it; without an origin, the sentence stays generic.
  const spaceNode = useOriginSpaceNode();
  const creationMode = usePackageAuthoringEnabled();
  const [skillsOpen, setSkillsOpen] = useState(false);
  // A popover opened while the menu is closing loses to the menu's focus
  // restore (Radix reads it as a focus-outside): open it once the menu is gone.
  const openSkillsAfterClose = useRef(false);

  const cluster = (
    <div className="flex min-w-0 items-center gap-1.5">
      <AttachButton
        label={t("composer.attach")}
        // An upload lands in the working space: where the chat does not act, or off the origin
        // of a limited conversation.
        unavailableReason={
          attach.available
            ? null
            : attach.reason === "limited"
              ? sentenceWithNode(t, "composer.attachLimited", spaceNode)
              : t("composer.attachUnavailable")
        }
      />
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
          {limit.available ? (
            <DropdownMenuCheckboxItem
              checked={scope.restricted}
              disabled={scope.pending}
              onCheckedChange={scope.setRestricted}
              aria-label={t("composer.limit", { name: spaceLabel })}
              data-testid="composer-limit-item"
            >
              {sentenceWithNode(t, "composer.limit", spaceNode)}
            </DropdownMenuCheckboxItem>
          ) : (
            // A turn generating, no origin space (« Tous les espaces »), or one the chat cannot act in.
            <UnavailableItem
              icon={<MapPinIcon />}
              label={t("composer.limit.generic")}
              reason={t(LIMIT_REASON_KEY[limit.reason])}
              testId="composer-limit-item"
            />
          )}
          {authorsPackages && (
            <DropdownMenuCheckboxItem
              checked={creationMode}
              onCheckedChange={setPackageAuthoringEnabled}
            >
              {/* The check mark takes the icon column, as Radix lays it out. */}
              {t("composer.creationMode")}
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
      {scope.restricted && (
        <RemovableChip
          icon={<MapPinIcon />}
          removeLabel={t("composer.limit.undo", { name: spaceLabel })}
          removeDisabled={scope.generating || scope.pending}
          onRemove={() => scope.setRestricted(false)}
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

/** A menu item that cannot be chosen here, with the reason under its label. */
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
      <span className="flex flex-col">
        {label}
        <span className="text-muted-foreground max-w-56 text-xs whitespace-normal">{reason}</span>
      </span>
    </DropdownMenuItem>
  );
}

/**
 * Opens the file dialog. Unavailable (`unavailableReason` set), it stays in place, disabled, with the
 * reason in a tooltip: a disabled button fires no pointer events, so the tooltip hangs on a
 * focusable wrapper that also carries the reason for a screen reader.
 */
function AttachButton({
  label,
  unavailableReason,
}: {
  label: string;
  unavailableReason: ReactNode | null;
}) {
  const button = (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      disabled={unavailableReason !== null}
      className={ICON_BUTTON}
      aria-label={label}
    >
      <PaperclipIcon />
    </Button>
  );
  if (unavailableReason === null) {
    return (
      <ComposerPrimitive.AddAttachment multiple asChild>
        {button}
      </ComposerPrimitive.AddAttachment>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="inline-flex shrink-0">
          {button}
          <span className="sr-only">{unavailableReason}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-64 text-xs">
        {unavailableReason}
      </TooltipContent>
    </Tooltip>
  );
}
