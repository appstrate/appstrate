// SPDX-License-Identifier: Apache-2.0

/**
 * The composer's tools panel, the same on every format: its rows (the skills, the model, the space
 * limit, creation mode), and the levels they open in their place, each named, with a way back —
 * the skills, the models (with the inline-run model switch and the context's detail), then one
 * model's settings. The container is the caller's: a popover from `md` up, a bottom sheet below
 * (`composer-tools.tsx`, `phone-composer-menu.tsx`). A phone's panel also holds attaching a file
 * and, as its last line, the disclaimer: its composer line has room for neither.
 */

import { useEffect, useId, useRef } from "react";
import { ComposerPrimitive } from "@assistant-ui/react";
import {
  BookOpenIcon,
  ChevronRightIcon,
  CpuIcon,
  MapPinIcon,
  PackageIcon,
  PaperclipIcon,
  SparklesIcon,
} from "lucide-react";
import { canComposeInlineRuns } from "../capabilities.ts";
import { attachUnavailableKey } from "./attachment-adapter.ts";
import { LIMIT_REASON_KEY } from "./composer-reasons.ts";
import { useComposerPanel } from "./composer-panel.ts";
import { ContextDetail } from "./context-gauge.tsx";
import { limitAvailability, useConversationScope, useSpaceName } from "./conversation-scope.ts";
import { setInlineRunModelEnabled, useInlineRunModelEnabled } from "./inline-run-model-store.ts";
import { useModelPicker } from "./model-picker.ts";
import { ModelPanel } from "./model-select.tsx";
import {
  setPackageAuthoringEnabled,
  usePackageAuthoringEnabled,
} from "./package-authoring-store.ts";
import { useChatHost } from "./runtime-context.ts";
import { SheetMenuRow, SheetMenuSwitchRow } from "./sheet-menu.tsx";
import { SkillsPickerPanel } from "./skills-picker.tsx";
import { useConversationSkillsContext, useDraftSkills } from "./use-conversation-skills.ts";

/** A line of explanation under a group of rows. */
function Hint({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-muted-foreground desktop-pointer:px-3 desktop-pointer:text-xs px-5 pb-2 text-sm">
      {children}
    </p>
  );
}

/** The space limit, as {@link limitAvailability} decides it: a switch, a choice among spaces, or why not. */
function LimitRows() {
  const { t, actingSpaceIds, renderSpaces } = useChatHost();
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
        testId="composer-limit-item"
      />
    );
  }
  if (limit.kind === "choose") {
    // No origin and several acting spaces: the space picked becomes the origin.
    return (
      <div
        role="group"
        aria-label={t("composer.limit.choose")}
        data-testid="composer-limit-item"
        className="flex flex-col"
      >
        <Hint>{t("composer.limit.choose")}</Hint>
        {limit.spaceIds.map((id) => (
          <SheetMenuRow key={id} onClick={() => scope.limitTo(id)}>
            {renderSpaces([id])}
          </SheetMenuRow>
        ))}
      </div>
    );
  }
  // A turn generating, no space to act in, an origin the chat no longer acts in, or the acting set
  // not known yet (no reason then).
  return (
    <>
      <SheetMenuRow disabled data-testid="composer-limit-item">
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

/** A row that opens a level: its name, what is chosen there, and the chevron that says it goes on. */
function LevelRow({
  icon,
  label,
  value,
  disabled,
  onClick,
  testId,
}: {
  icon: React.ReactNode;
  label: string;
  value?: string;
  disabled?: boolean;
  onClick: () => void;
  testId: string;
}) {
  return (
    <SheetMenuRow onClick={onClick} disabled={disabled} data-testid={testId}>
      {icon}
      <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
        <span className="shrink-0">{label}</span>
        {value && (
          <span className="text-muted-foreground desktop-pointer:text-xs truncate text-sm font-normal">
            {value}
          </span>
        )}
      </span>
      <ChevronRightIcon className="text-muted-foreground" aria-hidden />
    </SheetMenuRow>
  );
}

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

export function ComposerToolsPanel({
  authorsPackages,
  phone = false,
}: {
  authorsPackages: boolean;
  /** The phone's panel: attaching a file, and the disclaimer as its last line. */
  phone?: boolean;
}) {
  const { t, can, modelLabel } = useChatHost();
  const { level, setLevel, close } = useComposerPanel();
  // Offered with `skills:read` on a readable conversation: the context is null otherwise.
  const conversation = useConversationSkillsContext();
  const draft = useDraftSkills();
  const picker = useModelPicker();
  const creationMode = usePackageAuthoringEnabled();
  // Composing an inline run needs creation mode too: off, no turn launches one.
  const offersInlineRunModel = creationMode && canComposeInlineRuns(can);
  const inlineRunModel = useInlineRunModelEnabled();
  const creationId = useId();
  const inlineId = useId();
  const body = useRef<HTMLDivElement>(null);
  // Each level starts on its first control, the way back aside: the container's focus trap keeps
  // a focus already inside it.
  useEffect(() => {
    body.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  }, [level]);

  let content: React.ReactNode;
  if (level === "skills" && conversation) {
    content = (
      // The skills' own rows pad 4 px: the text lines up with the heading's.
      <div className="desktop-pointer:px-2 flex min-h-0 flex-col px-4 pb-2">
        <SkillsPickerPanel conversation={conversation} draft={draft} titled={false} />
      </div>
    );
  } else if ((level === "models" || level === "configuration") && picker) {
    content = (
      <>
        <ModelPanel
          {...picker}
          view={level}
          onViewChange={setLevel}
          // A pick is the end of the errand: back to the composer, which names it.
          onPicked={close}
          back={false}
        />
        {level === "models" && (
          <>
            {/* An expert's setting, beside the model it is about rather than in the main rows. */}
            {offersInlineRunModel && (
              <div className="border-t pt-1">
                <SheetMenuSwitchRow
                  id={inlineId}
                  icon={<CpuIcon />}
                  label={t("composer.inlineRunModel")}
                  hint={t("composer.inlineRunModel.hint")}
                  checked={inlineRunModel}
                  onCheckedChange={setInlineRunModelEnabled}
                  testId="composer-inline-run-model-item"
                />
              </div>
            )}
            <ContextDetail />
          </>
        )}
      </>
    );
  } else {
    const modelsEmpty = !picker || picker.models.length === 0;
    content = (
      <>
        {phone && <AttachRows onDone={close} />}
        {conversation && (
          <LevelRow
            icon={<BookOpenIcon />}
            label={t("composer.skills")}
            onClick={() => setLevel("skills")}
            testId="composer-panel-skills"
          />
        )}
        {picker && (
          <LevelRow
            icon={<SparklesIcon />}
            label={t("composer.model")}
            value={
              modelLabel ??
              (picker.failed
                ? t("model.loadFailed")
                : picker.pending
                  ? undefined
                  : t("model.select"))
            }
            disabled={modelsEmpty}
            onClick={() => setLevel("models")}
            testId="composer-panel-model"
          />
        )}
        <LimitRows />
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
        {phone && (
          <p className="text-muted-foreground mt-1 border-t px-5 pt-3 pb-2 text-sm">
            {t("thread.disclaimer")}
          </p>
        )}
      </>
    );
  }
  return (
    <div ref={body} className="flex min-h-0 flex-col" data-level={level}>
      {content}
    </div>
  );
}
