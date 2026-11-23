// SPDX-License-Identifier: Apache-2.0

/**
 * The composer's tools on a phone: ONE "+" at the left of the field that opens a panel from the
 * bottom with all of them (attach a file, the skills, the model, the space limit, creation mode),
 * as the chats people already use do. Nothing of them stays beside the field: a dot on the "+"
 * says one of the settings is off its default, and the panel names it. The skills and the model
 * open in the same panel, in place of its rows, with a way back. The disclaimer is the panel's
 * last line. From `md` up the composer keeps
 * its attach button, its settings menu, its model pill and its chips (`ComposerTools`).
 */

import { useId, useState } from "react";
import { ComposerPrimitive } from "@assistant-ui/react";
import {
  BookOpenIcon,
  CpuIcon,
  MapPinIcon,
  PackageIcon,
  PaperclipIcon,
  PlusIcon,
  SparklesIcon,
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
import { ModelPanel } from "./model-select.tsx";
import { selectedModel, useModelPicker } from "./model-picker.ts";
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

/** Where the panel is: its rows, or one of the panels they open in its place. */
type View = "tools" | "skills" | "models" | "configuration";

export function ComposerPlusMenu({ authorsPackages }: { authorsPackages: boolean }) {
  const { t, can, modelLabel } = useChatHost();
  // Offered with `skills:read` on a readable conversation: the context is null otherwise.
  const conversation = useConversationSkillsContext();
  const draft = useDraftSkills();
  const picker = useModelPicker();
  const creationMode = usePackageAuthoringEnabled();
  // Composing an inline run needs creation mode too: off, no turn launches one.
  const offersInlineRunModel = creationMode && canComposeInlineRuns(can);
  const inlineRunModel = useInlineRunModelEnabled();
  const [open, setOpen] = useState(false);
  // ONE panel that navigates: a level replaces the rows in place, never a second panel over the first.
  const [view, setView] = useState<View>("tools");
  const creationId = useId();
  const inlineId = useId();
  // A setting off its default: the "+" wears a dot, and the panel shows which.
  // The space limit is left out: it is on whenever a space is selected, so it would always show.
  const departed =
    (authorsPackages && !creationMode) ||
    (offersInlineRunModel && inlineRunModel) ||
    (conversation !== null && canResetSkills(conversation.skills));
  const close = () => setOpen(false);
  const toTools = { label: t("common:btn.back"), onClick: () => setView("tools") };
  const active = picker ? selectedModel(picker.models, picker.selectedId) : undefined;
  const sheet =
    view === "skills" && conversation
      ? { title: t("skills.title"), back: toTools }
      : view === "models" && picker
        ? { title: t("composer.model"), back: toTools }
        : view === "configuration" && picker && active
          ? {
              title: active.label ?? active.modelId ?? t("composer.model"),
              back: { label: t("common:btn.back"), onClick: () => setView("models") },
            }
          : { title: t("composer.tools"), back: undefined };
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
        onClick={() => {
          setView("tools");
          setOpen(true);
        }}
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
      <SheetMenu open={open} onOpenChange={setOpen} title={sheet.title} back={sheet.back}>
        {sheet.back === undefined ? (
          <>
            <AttachRows onDone={close} />
            {conversation && (
              <SheetMenuRow onClick={() => setView("skills")}>
                <BookOpenIcon />
                {t("composer.skills")}
              </SheetMenuRow>
            )}
            {picker && modelLabel && (
              <SheetMenuRow onClick={() => setView("models")} data-testid="composer-plus-model">
                <SparklesIcon />
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
            {/* The phone's composer line has no room for it: the panel's last line. */}
            <p className="text-muted-foreground mt-1 border-t px-5 pt-3 pb-2 text-sm">
              {t("thread.disclaimer")}
            </p>
          </>
        ) : view === "skills" && conversation ? (
          <div className="flex min-h-0 flex-col px-4">
            <SkillsPickerPanel conversation={conversation} draft={draft} titled={false} />
          </div>
        ) : picker ? (
          <>
            <ModelPanel
              {...picker}
              view={view === "configuration" ? "configuration" : "models"}
              onViewChange={setView}
              // A pick is the end of the errand: back to the composer, which names it.
              onPicked={close}
              back={false}
            />
            {/* An expert's setting, beside the model it is about rather than in the main rows. */}
            {view === "models" && offersInlineRunModel && (
              <div className="mt-1 border-t pt-1">
                <SheetMenuSwitchRow
                  id={inlineId}
                  icon={<CpuIcon />}
                  label={t("composer.inlineRunModel")}
                  hint={t("composer.inlineRunModel.hint")}
                  checked={inlineRunModel}
                  onCheckedChange={setInlineRunModelEnabled}
                />
              </div>
            )}
          </>
        ) : null}
      </SheetMenu>
    </>
  );
}
