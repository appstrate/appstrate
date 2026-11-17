// SPDX-License-Identifier: Apache-2.0

/**
 * The composer's left cluster: one "+" menu (attach files, skills, creation
 * mode) and, after it, a removable chip for each non-default setting that is
 * active. Settings live behind the menu, so the composer shows only what
 * differs from the defaults.
 */

import { useRef, useState, type ReactNode } from "react";
import { ComposerPrimitive } from "@assistant-ui/react";
import {
  BookOpenIcon,
  MapPinIcon,
  PackageIcon,
  PaperclipIcon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import { badgeVariants } from "@appstrate/ui/components/badge";
import { Button } from "@appstrate/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@appstrate/ui/components/dropdown-menu";
import { cn } from "@appstrate/ui/cn";
import type { ChatSkillSelection } from "../skills.ts";
import {
  limitAvailability,
  useAttachAvailability,
  useConversationScope,
  useOriginSpaceLabel,
  useOriginSpaceNode,
  useSpaceLabel,
  useSpaceNode,
  type LimitUnavailableReason,
} from "./conversation-scope.ts";
import {
  setPackageAuthoringEnabled,
  usePackageAuthoringEnabled,
} from "./package-authoring-store.ts";
import { useChatHost, type ChatTransport } from "./runtime-context.ts";
import { sentenceWithNode } from "./sentence-with-name.tsx";
import { SkillChips } from "./skill-chips.tsx";
import { SkillsPicker } from "./skills-picker.tsx";

const LIMIT_REASON_KEY: Record<LimitUnavailableReason, string> = {
  generating: "composer.limit.generating",
  "no-acting-space": "composer.limit.noActingSpace",
  outside: "composer.limit.outside",
};

export interface ComposerToolsProps {
  transport: ChatTransport | undefined;
  selection: ChatSkillSelection;
  onSelectionChange: (selection: ChatSkillSelection) => void;
  /** The skills picker is offered (`skills:read` + a readable conversation). */
  showPicker: boolean;
  /** The caller may author packages: the creation-mode switch is offered. */
  authorsPackages: boolean;
  /** Without the picker, a writer still sees the space's imposed skills. */
  showEnforced: boolean;
}

export function ComposerTools({
  transport,
  selection,
  onSelectionChange,
  showPicker,
  authorsPackages,
  showEnforced,
}: ComposerToolsProps) {
  const { t } = useChatHost();
  const scope = useConversationScope();
  const attach = useAttachAvailability();
  // The origin's plain name, for the accessible names: the node below carries a tile the name
  // does not. Without an origin, the sentence stays generic.
  const spaceLabel = useOriginSpaceLabel();
  const spaceNode = useOriginSpaceNode();
  const creationMode = usePackageAuthoringEnabled();
  const [skillsOpen, setSkillsOpen] = useState(false);
  // A popover opened while the menu is closing loses to the menu's focus
  // restore (Radix reads it as a focus-outside): open it once the menu is gone.
  const openSkillsAfterClose = useRef(false);

  const cluster = (
    <div className="flex min-w-0 items-center gap-1.5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="text-muted-foreground size-8 shrink-0 rounded-lg"
            aria-label={t("composer.tools")}
            data-testid="composer-tools-trigger"
          >
            <PlusIcon />
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
          {attach.available ? (
            <ComposerPrimitive.AddAttachment multiple asChild>
              <DropdownMenuItem>
                <PaperclipIcon />
                {t("composer.attach")}
              </DropdownMenuItem>
            </ComposerPrimitive.AddAttachment>
          ) : (
            // An upload lands in the working space: where the chat does not act, or off the
            // origin of a limited conversation.
            <UnavailableItem
              icon={<PaperclipIcon />}
              label={t("composer.attach")}
              reason={
                attach.reason === "limited"
                  ? sentenceWithNode(t, "composer.attachLimited", spaceNode)
                  : t("composer.attachUnavailable")
              }
              testId="composer-attach-item"
              reasonTestId="composer-attach-reason"
            />
          )}
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
          onRemove={scope.lift}
          testId="composer-limit-chip"
        >
          {sentenceWithNode(t, "composer.limitChip", spaceNode)}
        </RemovableChip>
      )}
      {(showPicker || showEnforced) && (
        <SkillChips
          transport={transport}
          selection={selection}
          onOpenPicker={showPicker ? () => setSkillsOpen(true) : undefined}
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
 * The « + » menu's limit entry, as {@link limitAvailability} decides: one click limiting to the
 * space it names, the host's sub-menu of the acting spaces for a conversation without an origin,
 * or an inert entry giving the reason.
 */
export function LimitMenuEntry() {
  const { t, actingSpaceIds, SpaceChoiceSubmenu } = useChatHost();
  const scope = useConversationScope();
  const limit = limitAvailability(scope, actingSpaceIds);
  // The space a click limits to (the origin, or the one acting space), else the origin.
  const named = limit.kind === "toggle" ? limit.spaceId : scope.originSpaceId;
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
    <SpaceChoiceSubmenu
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
    // A turn generating, no space to act in, or an origin the chat no longer acts in.
    <UnavailableItem
      icon={<MapPinIcon />}
      label={t("composer.limit.generic")}
      reason={t(LIMIT_REASON_KEY[limit.reason])}
      testId="composer-limit-item"
    />
  );
}

/** A menu item that cannot be chosen here, with the reason under its label. */
function UnavailableItem({
  icon,
  label,
  reason,
  testId,
  reasonTestId,
}: {
  icon: ReactNode;
  label: ReactNode;
  reason: ReactNode;
  testId: string;
  reasonTestId?: string;
}) {
  return (
    <DropdownMenuItem disabled data-testid={testId}>
      {icon}
      <span className="flex flex-col">
        {label}
        <span
          className="text-muted-foreground max-w-56 text-xs whitespace-normal"
          data-testid={reasonTestId}
        >
          {reason}
        </span>
      </span>
    </DropdownMenuItem>
  );
}

/** A setting that departs from the default, shown as a chip whose X restores the default. */
function RemovableChip({
  icon,
  children,
  removeLabel,
  removeDisabled = false,
  onRemove,
  testId,
}: {
  icon: ReactNode;
  children: ReactNode;
  removeLabel: string;
  removeDisabled?: boolean;
  onRemove: () => void;
  testId?: string;
}) {
  return (
    <span
      data-testid={testId}
      className={cn(
        badgeVariants({ variant: "secondary" }),
        "text-muted-foreground h-7 max-w-56 min-w-0 shrink gap-1.5 py-0 pr-1 pl-2.5 font-normal [&>svg]:size-3.5 [&>svg]:shrink-0",
      )}
    >
      {icon}
      <span className="block min-w-0 truncate">{children}</span>
      <button
        type="button"
        aria-label={removeLabel}
        disabled={removeDisabled}
        onClick={onRemove}
        className="hover:bg-foreground/10 flex size-5 shrink-0 items-center justify-center rounded-full disabled:pointer-events-none disabled:opacity-50"
      >
        <XIcon className="size-3" />
      </button>
    </span>
  );
}
