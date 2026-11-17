// SPDX-License-Identifier: Apache-2.0

/**
 * The composer's left cluster: one "+" menu (attach files, skills, creation
 * mode) and, after it, a removable chip for each non-default setting that is
 * active. Settings live behind the menu, so the composer shows only what
 * differs from the defaults.
 */

import { useRef, useState } from "react";
import { ComposerPrimitive } from "@assistant-ui/react";
import { BookOpenIcon, PackageIcon, PaperclipIcon, PlusIcon, XIcon } from "lucide-react";
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
  setPackageAuthoringEnabled,
  usePackageAuthoringEnabled,
} from "./package-authoring-store.ts";
import { useChatHost, type ChatTransport } from "./runtime-context.ts";
import { SkillChips } from "./enforced-skills.tsx";
import { SkillsChip, SkillsPicker } from "./skills-picker.tsx";

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
          <ComposerPrimitive.AddAttachment multiple asChild>
            <DropdownMenuItem>
              <PaperclipIcon />
              {t("composer.attach")}
            </DropdownMenuItem>
          </ComposerPrimitive.AddAttachment>
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
        <span
          className={cn(
            badgeVariants({ variant: "secondary" }),
            "text-muted-foreground h-7 shrink-0 gap-1.5 py-0 pr-1 pl-2.5 font-normal",
          )}
        >
          <PackageIcon className="size-3.5" />
          {t("composer.creationOff")}
          <button
            type="button"
            aria-label={t("composer.creationOff.undo")}
            onClick={() => setPackageAuthoringEnabled(true)}
            className="hover:bg-foreground/10 flex size-5 items-center justify-center rounded-full"
          >
            <XIcon className="size-3" />
          </button>
        </span>
      )}
      {(showPicker || showEnforced) && (
        <SkillChips
          transport={transport}
          selection={selection}
          onOpenPicker={showPicker ? () => setSkillsOpen(true) : undefined}
          fallback={
            showPicker ? (
              <SkillsChip selection={selection} onClick={() => setSkillsOpen(true)} />
            ) : null
          }
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
