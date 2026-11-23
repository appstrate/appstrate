// SPDX-License-Identifier: Apache-2.0

/**
 * The composer's tools on a phone: ONE "+" at the left of the field that opens a panel from the
 * bottom with all of them (attach a file, the skills, the space limit, creation mode and what
 * rides on it), as the chats people already use do. Nothing of them stays beside the field: a dot
 * on the "+" says one of the settings is off its default, and the panel names it. The disclaimer
 * that used to sit under the composer is the panel's last line. From `md` up the composer keeps
 * its attach button, its settings menu and its chips (`ComposerTools`).
 */

import { useId, useState, useSyncExternalStore } from "react";
import { ComposerPrimitive } from "@assistant-ui/react";
import {
  BookOpenIcon,
  CpuIcon,
  MapPinIcon,
  PackageIcon,
  PaperclipIcon,
  PlusIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { cn } from "@appstrate/ui/cn";
import { canComposeInlineRuns } from "../capabilities.ts";
import { canResetSkills } from "./chat-skills.ts";
import { attachUnavailableKey } from "./attachment-adapter.ts";
import { LIMIT_REASON_KEY } from "./composer-reasons.ts";
import { limitAvailability, useConversationScope, useSpaceName } from "./conversation-scope.ts";
import { setInlineRunModelEnabled, useInlineRunModelEnabled } from "./inline-run-model-store.ts";
import {
  setPackageAuthoringEnabled,
  usePackageAuthoringEnabled,
} from "./package-authoring-store.ts";
import { useChatHost } from "./runtime-context.ts";
import { useConversationSkillsContext, useDraftSkills } from "./use-conversation-skills.ts";
import {
  isToolsPanelOpen,
  setModelPanelOpen,
  setToolsPanelOpen,
  subscribeToolsPanel,
} from "./model-store.ts";
import { SheetMenu, SheetMenuRow, SheetMenuSwitchRow } from "./sheet-menu.tsx";
import { SkillsPickerPanel } from "./skills-picker.tsx";
import { COMPOSER_TOOL_BUTTON_CLASS } from "./touch-targets.ts";

/** A line of explanation under a group of rows. */
function Hint({ children }: { children: React.ReactNode }) {
  return <p className="text-muted-foreground px-5 pb-2 text-sm">{children}</p>;
}

/** The space limit, as {@link limitAvailability} decides it: a switch, a choice among spaces, or why not. */
function LimitRows({ onDone }: { onDone: () => void }) {
  const { t, actingSpaceIds, useSpaceLabelOf } = useChatHost();
  const labelOf = useSpaceLabelOf();
  const scope = useConversationScope();
  const limit = limitAvailability(scope, actingSpaceIds);
  const space = useSpaceName(limit.kind === "toggle" ? limit.spaceId : null);
  const switchId = useId();
  if (limit.kind === "toggle") {
    return (
      <SheetMenuSwitchRow
        id={switchId}
        icon={<MapPinIcon />}
        label={space ? t("composer.limit", { name: space.label }) : t("composer.limit.generic")}
        checked={scope.restricted}
        disabled={scope.pending}
        onCheckedChange={(on) => (on ? scope.limitTo(limit.spaceId) : scope.lift())}
      />
    );
  }
  if (limit.kind === "choose") {
    return (
      <>
        <p className="text-muted-foreground px-5 pt-2 pb-1 text-sm">{t("composer.limit.choose")}</p>
        {limit.spaceIds.map((id) => (
          <SheetMenuRow
            key={id}
            onClick={() => {
              scope.limitTo(id);
              onDone();
            }}
          >
            <MapPinIcon />
            {labelOf(id) ?? id}
          </SheetMenuRow>
        ))}
      </>
    );
  }
  return (
    <>
      <SheetMenuRow disabled>
        <MapPinIcon />
        {t("composer.limit.generic")}
      </SheetMenuRow>
      {limit.reason && <Hint>{t(LIMIT_REASON_KEY[limit.reason])}</Hint>}
    </>
  );
}

/** Attaching a file: it always goes to the caller's personal space, or the panel says why not. */
function AttachRows({ onDone }: { onDone: () => void }) {
  const { t, attachTarget } = useChatHost();
  if ("spaceId" in attachTarget) {
    return (
      <ComposerPrimitive.AddAttachment asChild>
        <SheetMenuRow onClick={onDone}>
          <PaperclipIcon />
          {t("composer.attach")}
        </SheetMenuRow>
      </ComposerPrimitive.AddAttachment>
    );
  }
  return (
    <>
      <SheetMenuRow disabled>
        <PaperclipIcon />
        {t("composer.attach")}
      </SheetMenuRow>
      <Hint>{t(attachUnavailableKey(attachTarget.unavailable))}</Hint>
    </>
  );
}

export function ComposerPlusMenu({ authorsPackages }: { authorsPackages: boolean }) {
  const { t, can, modelLabel } = useChatHost();
  // Offered with `skills:read` on a readable conversation: the context is null otherwise.
  const conversation = useConversationSkillsContext();
  const showPicker = conversation !== null;
  const draft = useDraftSkills();
  const creationMode = usePackageAuthoringEnabled();
  // Composing an inline run needs creation mode too: off, no turn launches one.
  const offersInlineRunModel = creationMode && canComposeInlineRuns(can);
  const inlineRunModel = useInlineRunModelEnabled();
  // In the store: the model panel this one opens comes back to it.
  const open = useSyncExternalStore(subscribeToolsPanel, isToolsPanelOpen, isToolsPanelOpen);
  const setOpen = setToolsPanelOpen;
  const [skillsOpen, setSkillsOpen] = useState(false);
  const creationId = useId();
  const inlineId = useId();
  // A setting off its default: the "+" wears a dot, and the panel shows which.
  // The space limit is left out: it is on whenever a space is selected, so it would always show.
  const departed =
    (authorsPackages && !creationMode) ||
    (offersInlineRunModel && inlineRunModel) ||
    (conversation !== null && canResetSkills(conversation.skills));
  const close = () => setOpen(false);
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn(COMPOSER_TOOL_BUTTON_CLASS, "relative md:hidden")}
        aria-label={t("composer.tools")}
        aria-haspopup="dialog"
        data-testid="composer-plus"
        onClick={() => setOpen(true)}
      >
        <PlusIcon />
        {departed && (
          <span
            aria-hidden
            data-testid="composer-plus-dot"
            className="bg-primary ring-card absolute top-1.5 right-1.5 size-2 rounded-full ring-2"
          />
        )}
      </Button>
      <SheetMenu open={open} onOpenChange={setOpen} title={t("composer.tools")}>
        <AttachRows onDone={close} />
        {showPicker && (
          <SheetMenuRow
            onClick={() => {
              close();
              setSkillsOpen(true);
            }}
          >
            <BookOpenIcon />
            {t("composer.skills")}
          </SheetMenuRow>
        )}
        {modelLabel && (
          <SheetMenuRow
            onClick={() => {
              close();
              setModelPanelOpen(true);
            }}
          >
            <SlidersHorizontalIcon />
            <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
              {t("composer.model")}
              <span className="text-muted-foreground truncate text-sm font-normal">
                {modelLabel}
              </span>
            </span>
          </SheetMenuRow>
        )}
        <LimitRows onDone={close} />
        {authorsPackages && (
          <SheetMenuSwitchRow
            id={creationId}
            icon={<PackageIcon />}
            label={t("composer.creationMode")}
            checked={creationMode}
            onCheckedChange={setPackageAuthoringEnabled}
          />
        )}
        {offersInlineRunModel && (
          <SheetMenuSwitchRow
            id={inlineId}
            icon={<CpuIcon />}
            label={t("composer.inlineRunModel")}
            hint={t("composer.inlineRunModel.hint")}
            checked={inlineRunModel}
            onCheckedChange={setInlineRunModelEnabled}
          />
        )}
        <p className="text-muted-foreground mt-1 border-t px-5 pt-3 pb-2 text-sm">
          {t("thread.disclaimer")}
        </p>
      </SheetMenu>
      {conversation && (
        <SheetMenu
          open={skillsOpen}
          onOpenChange={setSkillsOpen}
          title={t("skills.title")}
          className="flex flex-col p-4"
        >
          <SkillsPickerPanel conversation={conversation} draft={draft} />
        </SheetMenu>
      )}
    </>
  );
}
