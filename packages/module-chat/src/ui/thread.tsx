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
  useMessage,
  useAttachment,
  getExternalStoreMessages,
} from "@assistant-ui/react";
import {
  AlertTriangleIcon,
  ArrowDownIcon,
  CheckIcon,
  CopyIcon,
  FileIcon,
  PaperclipIcon,
  SendHorizontalIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import { turnLimitReached, turnMetadataFromMessage } from "@appstrate/core/chat-turn-metadata";
import { formatBytes } from "@appstrate/core/format";
import { Button } from "./button.tsx";
import { MarkdownText } from "./markdown-text.tsx";
import { ToolFallback } from "./tool-fallback.tsx";
import {
  InvokeOperationToolUI,
  SearchOperationsToolUI,
  DescribeOperationToolUI,
  GetMeToolUI,
  RunAndWaitToolUI,
} from "./tool-uis.tsx";
import { parseResume, INTEGRATION_RESUME_MARKER } from "./auth-offer.ts";
import { IntegrationIcon } from "./integration-icon.tsx";
import { documentContentHref, resolveAttachmentContent } from "./run-events.ts";
import { downloadChatDocument } from "./document-download.ts";
import { useChatHeaders, type GetHeaders } from "./runtime-context.ts";

export function Thread({ composerSlot }: { composerSlot?: React.ReactNode }) {
  return (
    <ThreadPrimitive.Root
      className="bg-background flex h-full flex-col"
      style={{ ["--thread-max-width" as string]: "42rem" }}
    >
      {/* Register the rich tool cards (these render nothing themselves). */}
      <InvokeOperationToolUI />
      <RunAndWaitToolUI />
      <SearchOperationsToolUI />
      <DescribeOperationToolUI />
      <GetMeToolUI />

      {/* Empty: composer centered mid-screen for a strong first impression.
          Non-empty: classic scrollable transcript with a sticky footer. */}
      <AuiIf condition={(s) => s.thread.isEmpty}>
        <ThreadWelcome composerSlot={composerSlot} />
      </AuiIf>

      <AuiIf condition={(s) => !s.thread.isEmpty}>
        {/* No `scroll-smooth`: the auto-follow scroll during streaming must be
            instant — smoothing turns every content append into a visible glide
            and amplifies any residual layout shift. */}
        <ThreadPrimitive.Viewport className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-4 pt-6">
          <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />

          <div className="min-h-6 flex-grow" />

          <ThreadPrimitive.ViewportFooter className="bg-background sticky bottom-0 mt-2 flex w-full max-w-(--thread-max-width) flex-col items-center gap-2 pb-4">
            <ScrollToBottom />
            <Composer slot={composerSlot} />
            <Disclaimer />
          </ThreadPrimitive.ViewportFooter>
        </ThreadPrimitive.Viewport>
      </AuiIf>
    </ThreadPrimitive.Root>
  );
}

// Generic, instance-agnostic prompts — must not reference any specific
// agent/package or org data (this UI ships to every Appstrate user).
const WELCOME_SUGGESTIONS = [
  "Que peux-tu faire ?",
  "Quels agents puis-je lancer ?",
  "Montre-moi mes derniers runs",
  "Cherche dans mes documents",
];

function ThreadWelcome({ composerSlot }: { composerSlot?: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4">
      <div className="flex w-full max-w-(--thread-max-width) flex-col items-stretch gap-6">
        <div className="text-center">
          <p className="text-lg font-medium">Appstrate Chat</p>
          <p className="text-muted-foreground mt-1 text-sm">
            Demandez à lancer un agent, inspecter un run, ou chercher dans vos documents.
          </p>
        </div>
        <Composer slot={composerSlot} />
        <div className="grid w-full grid-cols-1 gap-2 sm:grid-cols-2">
          {WELCOME_SUGGESTIONS.map((s) => (
            <ThreadPrimitive.Suggestion key={s} prompt={s} method="replace" autoSend asChild>
              <button
                type="button"
                className="hover:bg-accent rounded-lg border px-3 py-2 text-left text-sm transition-colors"
              >
                {s}
              </button>
            </ThreadPrimitive.Suggestion>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Honest, action-aware disclaimer — the chat triggers real runs. */
function Disclaimer() {
  return (
    <p className="text-muted-foreground/70 px-4 text-center text-xs">
      L’assistant peut se tromper et exécute de vraies actions — vérifiez avant de confirmer.
    </p>
  );
}

function ScrollToBottom() {
  return (
    <ThreadPrimitive.ScrollToBottom asChild>
      <Button
        variant="outline"
        size="icon"
        className="absolute -top-10 rounded-full disabled:invisible"
        aria-label="Aller en bas"
      >
        <ArrowDownIcon />
      </Button>
    </ThreadPrimitive.ScrollToBottom>
  );
}

/** A pending composer attachment chip: file icon, name, size, remove button. */
function ComposerAttachmentChip() {
  const name = useAttachment((a) => a.name);
  const size = useAttachment((a) => a.file?.size ?? 0);
  return (
    <AttachmentPrimitive.Root className="bg-muted flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs">
      <FileIcon className="text-muted-foreground size-3.5 shrink-0" />
      <span className="max-w-40 truncate font-medium">{name}</span>
      {size > 0 && <span className="text-muted-foreground shrink-0">{formatBytes(size)}</span>}
      <AttachmentPrimitive.Remove asChild>
        <button
          type="button"
          aria-label="Retirer la pièce jointe"
          className="text-muted-foreground hover:text-foreground ml-0.5 shrink-0"
        >
          <XIcon className="size-3.5" />
        </button>
      </AttachmentPrimitive.Remove>
    </AttachmentPrimitive.Root>
  );
}

/**
 * A sent file attachment, rendered from a message `file` part. The wire part
 * (ai-SDK `FileUIPart`) carries no byte size, so the chip shows the name + icon
 * only (the composer chip shows the size, read from the picked File).
 */
function FileAttachmentPart(props: { filename?: string }) {
  return (
    <div className="bg-background text-foreground mt-1 inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs">
      <FileIcon className="text-muted-foreground size-3.5 shrink-0" />
      <span className="max-w-52 truncate font-medium">{props.filename ?? "document"}</span>
    </div>
  );
}

// ─── Sent user-message attachments ───────────────────────────────────────────
// The `@assistant-ui/react-ai-sdk` converter filters user `file` parts OUT of a
// message's content and re-exposes them as `message.attachments` — so the
// `File: FileAttachmentPart` Parts mapping above NEVER fires for user messages
// (it stays correct for assistant file parts). We render sent attachments from
// the attachments channel instead (`MessagePrimitive.Attachments`).

const ATTACHMENT_CHIP_CLASS =
  "bg-background text-foreground inline-flex max-w-52 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs";

/** Inert chip: file icon + truncated name, no download (same look as FileAttachmentPart). */
function InertAttachmentChip({ name }: { name: string }) {
  return (
    <div className={ATTACHMENT_CHIP_CLASS}>
      <FileIcon className="text-muted-foreground size-3.5 shrink-0" />
      <span className="truncate font-medium">{name || "document"}</span>
    </div>
  );
}

/** Clickable chip: file icon + name, click triggers the authenticated download. */
function DownloadableAttachmentChip({
  name,
  onDownload,
}: {
  name: string;
  onDownload: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onDownload}
      title={`Télécharger ${name || "le document"}`}
      aria-label={`Télécharger ${name || "le document"}`}
      className={`${ATTACHMENT_CHIP_CLASS} hover:bg-muted`}
    >
      <FileIcon className="text-muted-foreground size-3.5 shrink-0" />
      <span className="truncate font-medium">{name || "document"}</span>
    </button>
  );
}

/**
 * Image attachment: an authenticated fetch of the content route → object URL in
 * an <img> thumbnail (revoked on unmount). While loading — or if the fetch
 * fails — it falls back to the downloadable chip. The content route only serves
 * stored documents, so this is only ever rendered for a resolved `document://`.
 */
function ImageAttachmentThumbnail({
  id,
  name,
  getHeaders,
  onDownload,
}: {
  id: string;
  name: string;
  getHeaders: GetHeaders | null;
  onDownload: () => void;
}) {
  const [src, setSrc] = React.useState<string | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    void (async () => {
      try {
        const res = await fetch(documentContentHref(id), {
          headers: getHeaders?.() ?? {},
          credentials: "include",
        });
        if (!res.ok || cancelled) return;
        const blob = await res.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      } catch {
        // Fetch failure → stay on the chip fallback (src stays null).
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id, getHeaders]);

  if (!src) return <DownloadableAttachmentChip name={name} onDownload={onDownload} />;
  return (
    <button
      type="button"
      onClick={onDownload}
      title={`Télécharger ${name || "l'image"}`}
      aria-label={`Télécharger ${name || "l'image"}`}
    >
      <img src={src} alt={name || "image"} className="max-h-36 rounded-lg border object-cover" />
    </button>
  );
}

/**
 * One sent attachment on a user message. A `document://` (server-persisted, or a
 * reloaded conversation) is interactive: image mime → thumbnail, else a
 * download chip. An `upload://` (just-sent optimistic, not yet materialized) or
 * unparseable URI is an inert chip — the content route serves documents only.
 */
function SentAttachmentChip() {
  const getHeaders = useChatHeaders();
  const name = useAttachment((a) => a.name);
  const contentType = useAttachment((a) => a.contentType);
  // The content array reference is stable for a settled attachment, so this
  // selector doesn't churn re-renders; memo keeps the resolved ref stable too.
  const content = useAttachment((a) => a.content);
  const resolved = React.useMemo(() => resolveAttachmentContent(content), [content]);

  if (resolved.kind !== "document") return <InertAttachmentChip name={name} />;

  const docId = resolved.id;
  const onDownload = () =>
    void downloadChatDocument(docId, name || "document", getHeaders?.() ?? {});

  if (typeof contentType === "string" && contentType.startsWith("image/")) {
    return (
      <ImageAttachmentThumbnail
        id={docId}
        name={name}
        getHeaders={getHeaders}
        onDownload={onDownload}
      />
    );
  }
  return <DownloadableAttachmentChip name={name} onDownload={onDownload} />;
}

function Composer({ slot }: { slot?: React.ReactNode }) {
  // No focus ring on the box: the app's global `textarea:focus` ring is too
  // intense here. min-h-9 + px-0 override the global `textarea { min-h-80px }`
  // base rule (utilities beat the base layer) for a compact, Codex-like field.
  return (
    <ComposerPrimitive.Root className="bg-card flex w-full flex-col gap-1 rounded-xl border px-3 py-2 shadow-sm">
      {/* Pending attachments, above the input. `empty:hidden` collapses the row
          (and its gap) when nothing is attached. */}
      <div className="flex flex-wrap gap-1.5 empty:hidden">
        <ComposerPrimitive.Attachments components={{ Attachment: ComposerAttachmentChip }} />
      </div>
      <ComposerPrimitive.Input
        rows={1}
        autoFocus
        placeholder="Message Appstrate…"
        className="placeholder:text-muted-foreground max-h-40 min-h-9 w-full resize-none border-0 bg-transparent px-0 py-1 text-sm shadow-none outline-none focus:ring-0 focus-visible:ring-0 focus-visible:outline-none"
      />
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1">
          <ComposerPrimitive.AddAttachment multiple asChild>
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground size-8 shrink-0 rounded-lg"
              aria-label="Joindre un fichier"
            >
              <PaperclipIcon />
            </Button>
          </ComposerPrimitive.AddAttachment>
          <div className="min-w-0">{slot}</div>
        </div>
        <ThreadPrimitive.If running={false}>
          <ComposerPrimitive.Send asChild>
            <Button size="icon" className="size-8 shrink-0 rounded-lg" aria-label="Envoyer">
              <SendHorizontalIcon />
            </Button>
          </ComposerPrimitive.Send>
        </ThreadPrimitive.If>
        <ThreadPrimitive.If running>
          <ComposerPrimitive.Cancel asChild>
            <Button
              size="icon"
              variant="secondary"
              className="size-8 shrink-0 rounded-lg"
              aria-label="Arrêter"
            >
              <SquareIcon className="size-3 fill-current" />
            </Button>
          </ComposerPrimitive.Cancel>
        </ThreadPrimitive.If>
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
  // render, so useMessage's reference-equality check doesn't churn re-renders.
  const resumeText = useMessage((m) => {
    const parts = (m.content ?? (m as { parts?: unknown[] }).parts ?? []) as unknown as Array<{
      text?: unknown;
    }>;
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
        <span className="bg-muted/50 text-muted-foreground inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs">
          <IntegrationIcon src={resume.icon} className="size-3.5" />
          <span className="font-medium">
            {resume.name || resume.packageId.split("/").pop() || "Intégration"}
          </span>
          <span>connectée</span>
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
        <div className="bg-muted text-foreground max-w-[80%] rounded-2xl px-4 py-2 text-sm whitespace-pre-wrap">
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

/**
 * Shown while the model hasn't produced anything visible yet. Height is pinned
 * to h-6 (24px) — exactly one prose-sm text line — so the dots→first-text swap
 * is a 0px layout change. Gated on the message actually running: a DEAD message
 * with no visible parts (e.g. a turn that errored before producing content)
 * must not animate "thinking" forever — that reads as a hung chat.
 */
function ThinkingIndicator() {
  const running = useMessage((m) => m.status?.type === "running");
  if (!running) return null;
  return (
    <div className="flex h-6 items-center gap-1" role="status" aria-label="L'assistant réfléchit…">
      <span className="bg-muted-foreground/70 size-1.5 animate-bounce rounded-full [animation-delay:-0.3s]" />
      <span className="bg-muted-foreground/70 size-1.5 animate-bounce rounded-full [animation-delay:-0.15s]" />
      <span className="bg-muted-foreground/70 size-1.5 animate-bounce rounded-full" />
    </div>
  );
}

/**
 * The ORIGINAL AI-SDK message behind an assistant-ui message. assistant-ui
 * normalizes `ThreadMessage.metadata` to its own shape ({custom, steps, …}) and
 * DROPS unknown keys — so the persisted `appstrate` turn metadata is only
 * reachable on the source message. Falls back to the message itself when no
 * source is bound.
 */
function sourceMessage(m: unknown): unknown {
  return (getExternalStoreMessages(m as never) as unknown[])[0] ?? m;
}

function TurnLimitNotice() {
  const reached = useMessage((m) => turnLimitReached(sourceMessage(m)));
  if (!reached) return null;
  return (
    <div className="text-muted-foreground mt-3 flex items-center gap-2 text-xs" role="status">
      <AlertTriangleIcon className="size-3.5 shrink-0" />
      <span>Réponse partielle : limite d'étapes atteinte.</span>
    </div>
  );
}

const GENERIC_TURN_ERROR = "La génération a échoué.";

/**
 * THE failure display for a turn — one component, one visual, live or
 * reloaded. The persisted turn metadata (`finishReason: "error"` + client-safe
 * `errorText`) is the preferred source since it survives reload; the transient
 * assistant-ui error status is the fallback for failures that never reached a
 * finish chunk (e.g. a hard ai-sdk stream error).
 */
function MessageError() {
  const errorText = useMessage((m) => {
    const turn = turnMetadataFromMessage(sourceMessage(m));
    if (turn?.finishReason === "error") return turn.errorText ?? GENERIC_TURN_ERROR;
    if (m.status?.type === "incomplete" && m.status.reason === "error") {
      const err = m.status.error;
      return typeof err === "string" && err ? err : GENERIC_TURN_ERROR;
    }
    return null;
  });
  if (!errorText) return null;
  return (
    <div
      role="alert"
      className="border-destructive/40 bg-destructive/10 text-destructive mt-2 rounded-md border px-3 py-2 text-sm break-words"
    >
      {errorText}
    </div>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="group flex w-full max-w-(--thread-max-width) flex-col py-2">
      <div className="text-foreground text-sm leading-relaxed">
        {/* Each tool call renders as its own card (no coalescing). Registered
            tool UIs resolve first; unregistered tools fall back to ToolFallback.
            Empty renders the thinking indicator while the model is still
            working and the last part isn't text. */}
        <MessagePrimitive.Parts
          components={{
            Text: MarkdownText,
            tools: { Fallback: ToolFallback },
            Empty: ThinkingIndicator,
          }}
        />
        <TurnLimitNotice />
        <MessageError />
      </div>
      <div className="mt-1 flex h-7 items-center gap-1">
        {/* Space permanently reserved (fixed h-7 wrapper) and the bar ALWAYS
            mounted, revealed by opacity only. `hideWhenRunning`/`autohide`
            would unmount it and collapse every assistant message by the bar's
            height at each inference start/finish — the whole transcript would
            visibly jump. Copy stays usable mid-stream (copies the current
            snapshot), which is the seamless behavior we want. */}
        <ActionBarPrimitive.Root className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <ActionBarPrimitive.Copy asChild>
            <IconButton label="Copier">
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
    variant="ghost"
    size="icon"
    className="text-muted-foreground size-7 [&_svg]:size-3.5"
    aria-label={label}
    title={label}
    {...props}
  >
    {children}
  </Button>
));
IconButton.displayName = "IconButton";
