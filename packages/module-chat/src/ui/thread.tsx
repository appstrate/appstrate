// SPDX-License-Identifier: Apache-2.0

/**
 * Styled chat thread built on assistant-ui primitives — ported from the
 * appstrate-chat satellite. Assistant text renders as markdown; each MCP tool
 * call renders as its own card. Single-path: no edit/regenerate/branch — the
 * server is the sole writer and chains turns linearly. Only copy (assistant)
 * is offered.
 */

import * as React from "react";
import {
  ThreadPrimitive,
  MessagePrimitive,
  ComposerPrimitive,
  AttachmentPrimitive,
  ActionBarPrimitive,
  AuiIf,
  useAui,
  useAuiEvent,
  useAuiState,
  unstable_useComposerInput,
} from "@assistant-ui/react";
import {
  AlertTriangleIcon,
  ArrowDownIcon,
  CheckIcon,
  CopyIcon,
  ListPlusIcon,
  PencilIcon,
  RotateCcwIcon,
  SendHorizontalIcon,
  SquareIcon,
  UploadIcon,
  XIcon,
} from "lucide-react";
import { turnLimitReached } from "@appstrate/core/chat-turn-metadata";
import { Alert, AlertDescription } from "@appstrate/ui/components/alert";
import { Button } from "@appstrate/ui/components/button";
import { cn } from "@appstrate/ui/cn";
import { MarkdownText, ReasoningText } from "./markdown-text.tsx";
import { ReasoningGroup, ThinkingStatus } from "./reasoning.tsx";
import { ToolFallback } from "./tool-fallback.tsx";
import {
  InvokeOperationToolUI,
  SearchOperationsToolUI,
  DescribeOperationToolUI,
  ImportPackageFileToolUI,
  RunAndWaitToolUI,
} from "./tool-uis.tsx";
import { parseResume, INTEGRATION_RESUME_MARKER } from "./auth-offer.ts";
import { IntegrationIcon } from "./integration-icon.tsx";
import { resolveAttachmentContent } from "./run-events.ts";
import { stagedImagePreviewUrl } from "./upload.ts";
import { actsIn, useChatHost, useChatTransport } from "./runtime-context.ts";
import { useAttachAvailability } from "./conversation-scope.ts";
import { sentenceWithName } from "./sentence-with-name.tsx";
import { sourceMessage, turnErrorState } from "./turn-error-state.ts";
import { turnModelLabel, turnModelSentenceKey } from "./turn-model.ts";
import { FileAttachment, InertAttachmentChip, ATTACHMENT_IMAGE_CLASS } from "./file-attachment.tsx";
import { isImageMime } from "@appstrate/core/mime";
import { takesDraft } from "./composer-draft.ts";
import {
  flushDecision,
  joinQueued,
  type MessageQueue,
  type QueueSnapshot,
} from "./message-queue.ts";

export function Thread({
  composerTools,
  composerSlot,
  initialComposerDraft,
  messageQueue,
}: {
  /** Left of the composer's bottom row: the attach button, the settings menu and the active-setting chips. */
  composerTools?: React.ReactNode;
  /** Right of it, before send: the model picker. */
  composerSlot?: React.ReactNode;
  initialComposerDraft?: string;
  /** Messages typed while the agent answers; created by the conversation, which also marks Stop on it. */
  messageQueue: MessageQueue;
}) {
  useQueueFlush(messageQueue);
  // Held above the welcome and footer composers: the draft seeds the conversation once.
  const draftSeededRef = React.useRef(false);
  const { can, t } = useChatHost();
  const attach = useAttachAvailability();
  return (
    // The whole thread is the drop target, welcome screen and transcript alike;
    // dropped files take the same adapter path as the picker. A reader gets no
    // drop target (and no overlay: `data-dragging` is only set when enabled).
    <ComposerPrimitive.AttachmentDropzone
      disabled={!can("chat:write") || !attach.available}
      className="group/drop relative h-full min-h-0"
    >
      <ThreadPrimitive.Root
        // `canvas`, not `background`: a full-page thread is a PAGE, and pages in
        // this shell are grey with white cards on top (the composer, the tool
        // cards). `background` is shadcn's component surface, which would make
        // the chat the one flat white screen in the product.
        className="bg-canvas flex h-full flex-col"
        style={{ ["--thread-max-width" as string]: "42rem" }}
      >
        {/* Register the rich tool cards (these render nothing themselves). */}
        <InvokeOperationToolUI />
        <RunAndWaitToolUI />
        <SearchOperationsToolUI />
        <DescribeOperationToolUI />
        <ImportPackageFileToolUI />

        {/* Empty: composer centered mid-screen for a strong first impression.
          Non-empty: classic scrollable transcript with a sticky footer. */}
        <AuiIf condition={(s) => s.thread.isEmpty}>
          <ThreadWelcome
            composerTools={composerTools}
            composerSlot={composerSlot}
            initialComposerDraft={initialComposerDraft}
            draftSeededRef={draftSeededRef}
            queue={messageQueue}
          />
        </AuiIf>

        <AuiIf condition={(s) => !s.thread.isEmpty}>
          {/* No `scroll-smooth`: the auto-follow scroll during streaming must be
            instant — smoothing turns every content append into a visible glide
            and amplifies any residual layout shift. `relative` makes the
            viewport the containing block of its absolutely positioned
            descendants (the `sr-only` labels): placed against an ancestor
            outside this scroller, they overflow the page into a second
            scrollbar. */}
          <ThreadPrimitive.Viewport className="relative flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-4 pt-6">
            <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />

            <div className="min-h-6 flex-grow" />

            <ThreadPrimitive.ViewportFooter className="bg-canvas sticky bottom-0 mt-2 flex w-full max-w-(--thread-max-width) flex-col items-center gap-2 pb-4">
              <ScrollToBottom />
              <Composer
                tools={composerTools}
                slot={composerSlot}
                initialDraft={initialComposerDraft}
                draftSeededRef={draftSeededRef}
                queue={messageQueue}
              />
              <Disclaimer />
            </ThreadPrimitive.ViewportFooter>
          </ThreadPrimitive.Viewport>
        </AuiIf>
      </ThreadPrimitive.Root>
      {/* The app's dropzone in its drag-over state (the form file field, the
          import dialog): dashed border, primary tint. Over the thread it needs
          a veil so the transcript does not show through. */}
      <div
        aria-hidden="true"
        className="bg-canvas/90 duration-base ease-surface pointer-events-none absolute inset-0 z-20 p-3 opacity-0 transition-opacity group-data-[dragging=true]/drop:opacity-100"
      >
        <div className="border-primary bg-primary/5 flex h-full flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed text-center">
          <UploadIcon className="text-primary motion-safe:group-data-[dragging=true]/drop:animate-in motion-safe:group-data-[dragging=true]/drop:slide-in-from-bottom-1 size-6" />
          <p className="text-sm font-medium">{t("composer.dropzone")}</p>
        </div>
      </div>
    </ComposerPrimitive.AttachmentDropzone>
  );
}

function ThreadWelcome({
  composerTools,
  composerSlot,
  initialComposerDraft,
  draftSeededRef,
  queue,
}: {
  composerTools?: React.ReactNode;
  composerSlot?: React.ReactNode;
  initialComposerDraft?: string;
  draftSeededRef: React.RefObject<boolean>;
  queue: MessageQueue;
}) {
  const { can, t, firstName: name, actingSpaceIds } = useChatHost();
  const canWrite = can("chat:write");
  // The host is looking at a space where the chat does not act (a viewer there): the conversation
  // still runs, in the caller's other spaces, and touches none of this one.
  const spaceId = useChatTransport()?.spaceId;
  const outsideActingSet = canWrite && !!spaceId && !actsIn(actingSpaceIds, spaceId);
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4">
      <div className="duration-base ease-surface motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 flex w-full max-w-(--thread-max-width) flex-col items-stretch gap-6">
        <div className="text-center">
          <h1 className="text-2xl font-semibold tracking-tight">
            {name ? t("welcome.greeting", { name }) : t("welcome.greetingAnonymous")}
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {/* A reader asks nothing: what there is to do is reread. */}
            {t(canWrite ? "welcome.hint" : "welcome.readOnly")}
          </p>
          {outsideActingSet && (
            <p className="text-muted-foreground mt-1 text-sm">{t("welcome.spaceNotActing")}</p>
          )}
        </div>
        <Composer
          tools={composerTools}
          slot={composerSlot}
          initialDraft={initialComposerDraft}
          draftSeededRef={draftSeededRef}
          queue={queue}
        />
      </div>
    </div>
  );
}

/**
 * Honest, action-aware disclaimer — the chat triggers real runs. A reader
 * triggers none, so it is not said to them.
 */
function Disclaimer() {
  const { can, t } = useChatHost();
  if (!can("chat:write")) return null;
  return (
    <p className="text-muted-foreground/70 px-4 text-center text-xs">{t("thread.disclaimer")}</p>
  );
}

function ScrollToBottom() {
  const { t } = useChatHost();
  return (
    <ThreadPrimitive.ScrollToBottom asChild>
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="absolute -top-10 rounded-full disabled:invisible"
        aria-label={t("thread.scrollToBottom")}
      >
        <ArrowDownIcon />
      </Button>
    </ThreadPrimitive.ScrollToBottom>
  );
}

/**
 * A pending image's thumbnail. The object URL lives exactly as long as the
 * element (React 19 ref cleanup), with no state round-trip. Not the staged
 * cache of `upload.ts`: that one is filled at send time, after the chip is gone.
 */
function PendingImage({ file, name }: { file: File; name: string }) {
  const attach = React.useCallback(
    (img: HTMLImageElement | null) => {
      if (!img) return;
      const url = URL.createObjectURL(file);
      img.src = url;
      return () => URL.revokeObjectURL(url);
    },
    [file],
  );
  return (
    <img
      ref={attach}
      alt={name || "image"}
      title={name}
      className="size-12 shrink-0 rounded-md border object-cover"
    />
  );
}

/** A pending composer attachment: an image thumbnail, else a chip (file icon, name, size); both removable. */
function ComposerAttachmentChip() {
  const name = useAuiState((s) => s.attachment.name);
  const file = useAuiState((s) => s.attachment.file);
  const size = file?.size ?? 0;
  const { formatBytes, t } = useChatHost();
  const previewFile = file && isImageMime(file.type) ? file : undefined;
  const remove = (
    <AttachmentPrimitive.Remove asChild>
      <button
        type="button"
        aria-label={t("composer.removeAttachment")}
        className={
          previewFile
            ? "bg-foreground/70 text-background hover:bg-foreground absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full"
            : "text-muted-foreground hover:text-foreground ml-0.5 shrink-0"
        }
      >
        <XIcon className={previewFile ? "size-3" : "size-3.5"} />
      </button>
    </AttachmentPrimitive.Remove>
  );
  if (previewFile) {
    return (
      <AttachmentPrimitive.Root className="relative inline-flex">
        <PendingImage file={previewFile} name={name} />
        {remove}
      </AttachmentPrimitive.Root>
    );
  }
  return (
    <AttachmentPrimitive.Root className="inline-flex">
      <InertAttachmentChip
        name={name}
        trailing={
          <>
            {size > 0 && (
              <span className="text-muted-foreground shrink-0">{formatBytes(size)}</span>
            )}
            {remove}
          </>
        }
      />
    </AttachmentPrimitive.Root>
  );
}

/**
 * A sent file attachment, rendered from a message `file` part. The wire part
 * (ai-SDK `FileUIPart`) carries no byte size, so the chip shows the name + icon
 * only (the composer chip shows the size, read from the picked File).
 */
function FileAttachmentPart({ filename }: { filename?: string }) {
  return (
    <div className="mt-1">
      <InertAttachmentChip name={filename ?? ""} />
    </div>
  );
}

// ─── Sent user-message attachments ───────────────────────────────────────────
// The `@assistant-ui/react-ai-sdk` converter filters user `file` parts OUT of a
// message's content and re-exposes them as `message.attachments` — so the
// `File: FileAttachmentPart` Parts mapping above NEVER fires for user messages
// (it stays correct for assistant file parts). We render sent attachments from
// the attachments channel instead (`MessagePrimitive.Attachments`).

/**
 * One sent attachment on a user message. An `appfile://` (server-persisted, or a
 * reloaded conversation) is interactive: image mime → thumbnail, else a
 * download chip. An `upload://` (just-sent optimistic, not yet materialized) or
 * unparseable URI shows the local File as a thumbnail when it's an image still
 * held by the runtime, else an inert chip — the content route serves files
 * only.
 */
function SentAttachmentChip() {
  const name = useAuiState((s) => s.attachment.name);
  const contentType = useAuiState((s) => s.attachment.contentType);
  // The content array reference is stable for a settled attachment, so this
  // selector doesn't churn re-renders; memo keeps the resolved ref stable too.
  const content = useAuiState((s) => s.attachment.content);
  const resolved = React.useMemo(() => resolveAttachmentContent(content), [content]);

  if (resolved.kind !== "file") {
    // Just-sent optimistic attachment (`upload://`, not yet materialized): the
    // staged-image cache still holds a local preview of the picked file. Not
    // interactive — there is no file id to preview or download yet; the
    // persisted `appfile://` part takes over on reload.
    const localSrc = resolved.uri ? stagedImagePreviewUrl(resolved.uri) : undefined;
    if (localSrc && isImageMime(contentType))
      return <img src={localSrc} alt={name || "image"} className={ATTACHMENT_IMAGE_CLASS} />;
    return <InertAttachmentChip name={name} />;
  }

  // A resolved `appfile://` is interactive: the unified renderer shows an image
  // thumbnail or a download/preview chip, resolving the opener-vs-download action.
  return (
    <FileAttachment
      file={{ id: resolved.id, name, mime: contentType, spaceId: resolved.spaceId }}
    />
  );
}

/** Why a picked file did not become a chip: a refused file has no attachment to carry the error. */
function ComposerAttachmentError() {
  const [message, setMessage] = React.useState<string | null>(null);
  useAuiEvent("composer.attachmentAddError", (event) => setMessage(event.message));
  useAuiEvent("composer.attachmentAdd", () => setMessage(null));
  useAuiEvent("composer.send", () => setMessage(null));
  if (!message) return null;
  return (
    <p role="alert" className="text-destructive text-xs">
      {message}
    </p>
  );
}

/** Sends everything queued as ONE user message, then empties the queue. */
function sendQueued(aui: ReturnType<typeof useAui>, queue: MessageQueue) {
  const text = joinQueued(queue.getSnapshot().items);
  queue.clear();
  aui.thread().append({ content: [{ type: "text", text }] });
}

/**
 * Sends the queue when a turn ends (error included). A turn the user stopped
 * keeps its queue: the composer offers a manual send instead. Lives in `Thread`,
 * which outlives both composers (welcome and footer).
 */
function useQueueFlush(queue: MessageQueue) {
  const aui = useAui();
  const running = useAuiState((s) => s.thread.isRunning);
  const wasRunning = React.useRef(false);
  React.useEffect(() => {
    const decision = flushDecision({
      wasRunning: wasRunning.current,
      running,
      snapshot: queue.getSnapshot(),
    });
    const ended = wasRunning.current && !running;
    wasRunning.current = running;
    if (decision === "send") sendQueued(aui, queue);
    // A Stop only holds the queue for the turn it stopped.
    else if (ended) queue.releaseStop();
  }, [running, aui, queue]);
}

/** The queued messages, as a compact list at the top of the composer card. */
function QueuedMessages({
  queue,
  running,
  composerEmpty,
  onEdit,
}: {
  queue: MessageQueue;
  running: boolean;
  composerEmpty: boolean;
  onEdit: (text: string) => void;
}) {
  const { t } = useChatHost();
  const aui = useAui();
  const { items }: QueueSnapshot = React.useSyncExternalStore(
    queue.subscribe,
    queue.getSnapshot,
    queue.getSnapshot,
  );
  if (items.length === 0) return null;
  return (
    <div className="mb-1 flex flex-col gap-1 border-b pb-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-muted-foreground text-xs font-medium">
          {t(running ? "composer.queue.title" : "composer.queue.titleHeld")}
        </p>
        {!running && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => sendQueued(aui, queue)}
          >
            {t("composer.queue.sendNow")}
          </Button>
        )}
      </div>
      <ul className="flex flex-col gap-0.5">
        {items.map((text, index) => (
          // Texts may repeat and the list only ever shrinks or appends: the index is the identity.
          <li key={index} className="text-muted-foreground flex items-center gap-1 text-xs">
            <span className="min-w-0 flex-1 truncate" title={text}>
              {text}
            </span>
            <IconButton
              label={t("composer.queue.edit")}
              className="size-6"
              disabled={!composerEmpty}
              onClick={() => {
                queue.remove(index);
                onEdit(text);
              }}
            >
              <PencilIcon />
            </IconButton>
            <IconButton
              label={t("composer.queue.remove")}
              className="size-6"
              onClick={() => queue.remove(index)}
            >
              <XIcon />
            </IconButton>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Composer({
  tools,
  slot,
  initialDraft,
  draftSeededRef,
  queue,
}: {
  tools?: React.ReactNode;
  slot?: React.ReactNode;
  initialDraft?: string;
  draftSeededRef: React.RefObject<boolean>;
  queue: MessageQueue;
}) {
  const { can, t } = useChatHost();
  const composer = unstable_useComposerInput();
  const running = useAuiState((s) => s.thread.isRunning);
  const hasAttachments = useAuiState((s) => s.composer.attachments.length > 0);
  // Only text is queued: attachments stay in the composer until the next real send.
  const canQueue = running && !hasAttachments && composer.value.trim() !== "";
  const enqueue = () => {
    if (canQueue && queue.add(composer.value)) composer.setText("");
  };
  React.useEffect(() => {
    if (!takesDraft(initialDraft, { seeded: draftSeededRef.current, typed: composer.value }))
      return;
    draftSeededRef.current = true;
    composer.setText(initialDraft);
  }, [composer, initialDraft, draftSeededRef]);
  // Sending, stopping and attaching all guard on `chat:write`.
  if (!can("chat:write")) {
    return (
      <p className="text-muted-foreground bg-card w-full rounded-xl border px-3 py-3 text-center text-sm">
        {t("composer.readOnly")}
      </p>
    );
  }
  // No focus ring on the box: the app's global `textarea:focus` ring is too
  // intense here. min-h-9 + px-0 override the global `textarea { min-h-80px }`
  // base rule (utilities beat the base layer) for a compact, Codex-like field.
  return (
    <ComposerPrimitive.Root className="bg-card flex w-full flex-col gap-1 rounded-xl border px-3 py-2 shadow-sm">
      {/* Pending attachments, above the input. `empty:hidden` collapses the row
          (and its gap) when nothing is attached. */}
      <QueuedMessages
        queue={queue}
        running={running}
        composerEmpty={composer.value.trim() === ""}
        onEdit={composer.setText}
      />
      <div className="flex flex-wrap gap-1.5 empty:hidden">
        <ComposerPrimitive.Attachments components={{ Attachment: ComposerAttachmentChip }} />
      </div>
      <ComposerAttachmentError />
      <ComposerPrimitive.Input
        rows={1}
        autoFocus
        addAttachmentOnPaste
        placeholder={t("composer.placeholder")}
        onKeyDown={(e) => {
          // While the agent answers the primitive ignores Enter; it queues instead.
          if (!running || e.key !== "Enter" || e.shiftKey || e.ctrlKey || e.metaKey) return;
          if (e.nativeEvent.isComposing) return;
          e.preventDefault();
          enqueue();
        }}
        className="placeholder:text-muted-foreground max-h-40 min-h-9 w-full resize-none border-0 bg-transparent px-0 py-1 text-sm shadow-none outline-none focus:ring-0 focus-visible:ring-0 focus-visible:outline-none"
      />
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">{tools}</div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="min-w-0">{slot}</div>
          <ThreadPrimitive.If running={false}>
            <ComposerPrimitive.Send asChild>
              <Button
                type="button"
                size="icon"
                className="size-8 shrink-0 rounded-lg"
                aria-label={t("composer.send")}
              >
                <SendHorizontalIcon />
              </Button>
            </ComposerPrimitive.Send>
          </ThreadPrimitive.If>
          <ThreadPrimitive.If running>
            <Button
              type="button"
              size="icon"
              variant="outline"
              className="size-8 shrink-0 rounded-lg"
              aria-label={t("composer.queue.add")}
              title={t("composer.queue.add")}
              disabled={!canQueue}
              onClick={enqueue}
            >
              <ListPlusIcon />
            </Button>
            <ComposerPrimitive.Cancel asChild>
              <Button
                type="button"
                size="icon"
                variant="secondary"
                className="size-8 shrink-0 rounded-lg"
                aria-label={t("composer.stop")}
              >
                <SquareIcon className="fill-current" />
              </Button>
            </ComposerPrimitive.Cancel>
          </ThreadPrimitive.If>
        </div>
      </div>
    </ComposerPrimitive.Root>
  );
}

// ─── User message (bubble only — no edit/branch on a single-path thread) ─────

function UserMessage() {
  // The OAuth auto-resume turn (oauth-connect-card) is a real user message — it
  // drives the model to continue — but showing its raw text as a bubble is
  // noise. Detect the marker prefix and render a discreet "connected" notice
  // instead. Reads the message's first text part (survives reload, since the
  // marker is persisted with the message).
  // Return a stable string from the selector (not a fresh object) and parse in
  // render, so useAuiState's reference-equality check doesn't churn re-renders.
  const { t } = useChatHost();
  const resumeText = useAuiState(({ message: m }) => {
    const parts = (m.content ?? (m as { parts?: readonly unknown[] }).parts ?? []) as readonly {
      text?: unknown;
    }[];
    for (const p of parts) {
      if (typeof p?.text === "string" && p.text.startsWith(INTEGRATION_RESUME_MARKER))
        return p.text;
    }
    return null;
  });
  const resume = resumeText ? parseResume(resumeText) : null;

  if (resume) {
    return (
      <MessagePrimitive.Root className="flex w-full max-w-(--thread-max-width) justify-center py-1.5">
        <span className="bg-muted/40 text-muted-foreground inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs">
          <IntegrationIcon src={resume.icon} className="size-3.5" />
          <span>
            {sentenceWithName(
              t,
              "connect.resumed",
              resume.name || resume.packageId.split("/").pop() || t("connect.integrationName"),
            )}
          </span>
          <CheckIcon className="text-primary size-3.5" />
        </span>
      </MessagePrimitive.Root>
    );
  }

  return (
    <MessagePrimitive.Root className="group flex w-full max-w-(--thread-max-width) flex-col items-end py-2">
      {/* Sent attachments render ABOVE the bubble, in their own right-aligned
          wrap-row. They live on `message.attachments` (the converter's file-part
          routing), not in the bubble's Parts. Guarded so an attachment-less
          message renders exactly as before. */}
      <MessagePrimitive.If hasAttachments>
        <div className="mb-1 flex max-w-[80%] flex-wrap justify-end gap-1.5">
          <MessagePrimitive.Attachments components={{ Attachment: SentAttachmentChip }} />
        </div>
      </MessagePrimitive.If>
      {/* The text bubble. Guarded on content so an attachment-only message (no
          text part) doesn't paint an empty grey pill. */}
      <MessagePrimitive.If hasContent>
        {/* A white card on the canvas, like every other surface in the thread
            (the composer, the tool cards). `bg-muted` was a hollow on white and
            reads as a smudge on grey — 3 points of luminance from the page. */}
        <div className="bg-card text-foreground max-w-[80%] rounded-2xl border px-4 py-2 text-sm whitespace-pre-wrap shadow-sm">
          <MessagePrimitive.Parts components={{ File: FileAttachmentPart }} />
        </div>
      </MessagePrimitive.If>
    </MessagePrimitive.Root>
  );
}

// ─── Assistant message (markdown + tools, copy only) ─────────────────────────
// No edit/regenerate/branch actions: the server is the single writer and chains
// turns linearly (flat list, no branches). Client-side edit/reload would create
// branches that aren't persisted — corrupting history on reload — so they're
// intentionally absent.

/** Gated on running: a dead message with no visible parts must not animate "thinking" forever. */
function ThinkingIndicator() {
  const running = useAuiState((s) => s.message.status?.type === "running");
  return running ? <ThinkingStatus /> : null;
}

/** Always shown, not on hover, so a mid-conversation model switch is visible. */
function TurnModelBadge() {
  const { t } = useChatHost();
  // A plain string selector — never a derived object. See `turn-error-state.ts`.
  const label = useAuiState((s) => turnModelLabel(s.message));
  const sentenceKey = useAuiState((s) => turnModelSentenceKey(s.message));
  if (label === null) return null;
  const sentence = t(sentenceKey, { model: label });
  return (
    // `min-w-0` lets `truncate` shrink inside the flex row. Assistive tech reads
    // the full sentence: a bare model name says nothing out of context.
    <span className="text-muted-foreground max-w-[14rem] min-w-0 truncate text-xs" title={sentence}>
      <span aria-hidden="true">{label}</span>
      <span className="sr-only">{sentence}</span>
    </span>
  );
}

function TurnLimitNotice() {
  const { t } = useChatHost();
  const reached = useAuiState((s) => turnLimitReached(sourceMessage(s.message)));
  if (!reached) return null;
  return (
    <div className="text-muted-foreground mt-3 flex items-center gap-2 text-xs" role="status">
      <AlertTriangleIcon className="size-3.5 shrink-0" />
      <span>{t("turn.stepLimitReached")}</span>
    </div>
  );
}

/**
 * THE failure display for a turn — one component, one visual, live or
 * reloaded. The persisted provider-neutral category is localized here and
 * survives reload; the transient assistant-ui marker covers failures that have
 * not reached a finish chunk yet.
 */
export function MessageError() {
  const { t, can, personalModelCredentials } = useChatHost();
  // Select a plain field, never a derived object: this selector IS
  // `useSyncExternalStore`'s getSnapshot. See `turn-error-state.ts`.
  const message = useAuiState((s) => s.message);
  const errorState = React.useMemo(
    () => turnErrorState(message, t, can, personalModelCredentials),
    [message, t, can, personalModelCredentials],
  );
  if (!errorState) return null;
  return (
    <Alert
      variant="destructive"
      className="mt-2 break-words"
      action={
        errorState.action || errorState.retryable ? (
          <div className="flex gap-2">
            {errorState.action ? (
              <Button asChild variant="outline" size="sm">
                <a href={errorState.action.href}>{errorState.action.label}</a>
              </Button>
            ) : null}
            {errorState.retryable ? (
              <ThreadPrimitive.If running={false}>
                <ThreadPrimitive.Suggestion
                  prompt={t("turn.retryPrompt")}
                  method="replace"
                  autoSend
                  asChild
                >
                  <Button type="button" variant="outline" size="sm">
                    <RotateCcwIcon />
                    {t("common:btn.retry")}
                  </Button>
                </ThreadPrimitive.Suggestion>
              </ThreadPrimitive.If>
            ) : null}
          </div>
        ) : null
      }
    >
      <AlertDescription>
        {errorState.text}
        {errorState.requestId ? (
          <span className="text-muted-foreground mt-1 block text-xs">
            {t("turn.error.requestId", { id: errorState.requestId })}
          </span>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

/** Module-level: assistant-ui memoizes each part on these members' identity. */
const ASSISTANT_PART_COMPONENTS = {
  Text: MarkdownText,
  Reasoning: ReasoningText,
  ReasoningGroup,
  tools: { Fallback: ToolFallback },
  Empty: ThinkingIndicator,
} satisfies React.ComponentProps<typeof MessagePrimitive.Parts>["components"];

function AssistantMessage() {
  const { t } = useChatHost();
  return (
    <MessagePrimitive.Root className="group flex w-full max-w-(--thread-max-width) flex-col py-2">
      <div className="text-foreground text-sm leading-relaxed">
        <MessagePrimitive.Parts components={ASSISTANT_PART_COMPONENTS} />
        <TurnLimitNotice />
        <MessageError />
      </div>
      <div className="mt-1 flex h-7 items-center gap-2">
        <TurnModelBadge />
        {/* Space permanently reserved (fixed h-7 wrapper) and the bar ALWAYS
            mounted, revealed by opacity only. `hideWhenRunning`/`autohide`
            would unmount it and collapse every assistant message by the bar's
            height at each inference start/finish — the whole transcript would
            visibly jump. Copy stays usable mid-stream (copies the current
            snapshot), which is the seamless behavior we want. */}
        <ActionBarPrimitive.Root className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <ActionBarPrimitive.Copy asChild>
            <IconButton label={t("common:btn.copy")}>
              <MessagePrimitive.If copied>
                <CheckIcon />
              </MessagePrimitive.If>
              <MessagePrimitive.If copied={false}>
                <CopyIcon />
              </MessagePrimitive.If>
            </IconButton>
          </ActionBarPrimitive.Copy>
        </ActionBarPrimitive.Root>
      </div>
    </MessagePrimitive.Root>
  );
}

// ─── Shared bits ─────────────────────────────────────────────────────────────

// forwardRef + prop spread so `asChild`/Slot-injected handlers (onClick from
// the action-bar/branch-picker primitives) actually reach the button.
const IconButton = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<typeof Button> & { label: string }
>(({ label, children, ...props }, ref) => (
  <Button
    ref={ref}
    type="button"
    variant="ghost"
    size="icon"
    aria-label={label}
    title={label}
    {...props}
    className={cn("text-muted-foreground size-7 [&_svg]:size-3.5", props.className)}
  >
    {children}
  </Button>
));
IconButton.displayName = "IconButton";
