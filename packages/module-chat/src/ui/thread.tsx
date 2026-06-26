// SPDX-License-Identifier: Apache-2.0

/**
 * Styled chat thread built on assistant-ui primitives — ported from the
 * appstrate-chat satellite. Assistant text renders as markdown; MCP tool
 * calls render as collapsible cards (consecutive calls coalesce into one
 * group card). Single-path: no edit/regenerate/branch — the server is the
 * sole writer and chains turns linearly. Only copy (assistant) is offered.
 */

import * as React from "react";
import {
  ThreadPrimitive,
  MessagePrimitive,
  ComposerPrimitive,
  ActionBarPrimitive,
  ErrorPrimitive,
  AuiIf,
  useMessage,
  groupPartByType,
} from "@assistant-ui/react";
import { ArrowDownIcon, CheckIcon, CopyIcon, SendHorizontalIcon, SquareIcon } from "lucide-react";
import { Button } from "./button.tsx";
import { CollapsibleToolCard } from "./collapsible-tool-card.tsx";
import { MarkdownText } from "./markdown-text.tsx";
import { ToolFallback } from "./tool-fallback.tsx";
import { InvokeOperationToolUI } from "./tool-uis.tsx";
import { parseResume, INTEGRATION_RESUME_MARKER } from "./auth-offer.ts";
import { IntegrationIcon } from "./integration-icon.tsx";

export function Thread({ composerSlot }: { composerSlot?: React.ReactNode }) {
  return (
    <ThreadPrimitive.Root
      className="bg-background flex h-full flex-col"
      style={{ ["--thread-max-width" as string]: "42rem" }}
    >
      {/* Register the rich tool cards (these render nothing themselves). */}
      <InvokeOperationToolUI />

      {/* Empty: composer centered mid-screen for a strong first impression.
          Non-empty: classic scrollable transcript with a sticky footer. */}
      <AuiIf condition={(s) => s.thread.isEmpty}>
        <ThreadWelcome composerSlot={composerSlot} />
      </AuiIf>

      <AuiIf condition={(s) => !s.thread.isEmpty}>
        <ThreadPrimitive.Viewport className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto scroll-smooth px-4">
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

function Composer({ slot }: { slot?: React.ReactNode }) {
  // No focus ring on the box: the app's global `textarea:focus` ring is too
  // intense here. min-h-9 + px-0 override the global `textarea { min-h-80px }`
  // base rule (utilities beat the base layer) for a compact, Codex-like field.
  return (
    <ComposerPrimitive.Root className="bg-card flex w-full flex-col gap-1 rounded-xl border px-3 py-2 shadow-sm">
      <ComposerPrimitive.Input
        rows={1}
        autoFocus
        placeholder="Message Appstrate…"
        className="placeholder:text-muted-foreground max-h-40 min-h-9 w-full resize-none border-0 bg-transparent px-0 py-1 text-sm shadow-none outline-none focus:ring-0 focus-visible:ring-0 focus-visible:outline-none"
      />
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">{slot}</div>
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
      <div className="bg-muted text-foreground max-w-[80%] rounded-2xl px-4 py-2 text-sm whitespace-pre-wrap">
        <MessagePrimitive.Parts />
      </div>
    </MessagePrimitive.Root>
  );
}

// ─── Assistant message (markdown + tools, copy only) ─────────────────────────
// No edit/regenerate/branch actions: the server is the single writer and chains
// turns linearly (flat list, no branches). Client-side edit/reload would create
// branches that aren't persisted — corrupting history on reload — so they're
// intentionally absent.

/** Shown while the model hasn't produced anything visible yet. */
function ThinkingIndicator() {
  return (
    <div className="flex items-center gap-1 py-2" role="status" aria-label="L'assistant réfléchit…">
      <span className="bg-muted-foreground/70 size-1.5 animate-bounce rounded-full [animation-delay:-0.3s]" />
      <span className="bg-muted-foreground/70 size-1.5 animate-bounce rounded-full [animation-delay:-0.15s]" />
      <span className="bg-muted-foreground/70 size-1.5 animate-bounce rounded-full" />
    </div>
  );
}

/** Collapsible card wrapping a run of consecutive tool calls. */
function ToolGroup({
  count,
  running,
  children,
}: React.PropsWithChildren<{ count: number; running: boolean }>) {
  return (
    <CollapsibleToolCard
      running={running}
      header={
        <>
          <span className="text-muted-foreground">tools</span>{" "}
          <span className="font-medium">{count} appels</span>
        </>
      }
    >
      <div className="border-t px-3 pt-3">{children}</div>
    </CollapsibleToolCard>
  );
}

// Module-level so the helper's memo fingerprint keeps the group tree stable
// across re-renders. Adjacent tool calls coalesce under "group-tools", except
// tool UIs marked `display: "standalone"`, which get an empty path and render
// outside the pli.
const groupToolCalls = groupPartByType({
  "tool-call": ["group-tools"],
  "standalone-tool-call": [],
});

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="group flex w-full max-w-(--thread-max-width) flex-col py-2">
      <div className="text-foreground text-sm leading-relaxed">
        <MessagePrimitive.GroupedParts groupBy={groupToolCalls}>
          {({ part, children }) => {
            switch (part.type) {
              case "group-tools":
                // A lone tool call keeps its own card — no wrapper for 1.
                if (part.indices.length === 1) return children;
                return (
                  <ToolGroup count={part.indices.length} running={part.status.type === "running"}>
                    {children}
                  </ToolGroup>
                );
              case "text":
                return <MarkdownText />;
              case "tool-call":
                return part.toolUI ?? <ToolFallback {...part} />;
              // Emitted while running when the last part isn't text (e.g.
              // between a tool result and the next streamed token).
              case "indicator":
                return <ThinkingIndicator />;
              default:
                return null;
            }
          }}
        </MessagePrimitive.GroupedParts>
      </div>
      <MessageError />
      <div className="mt-1 flex items-center gap-1">
        {/* Always mounted (space reserved), revealed by opacity — `autohide`
            would unmount it and shift the layout on hover. */}
        <ActionBarPrimitive.Root
          hideWhenRunning
          className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100"
        >
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

// ErrorPrimitive.Root renders unconditionally (a role="alert" div), so gate it
// on the message error status to avoid an empty box on successful turns.
function MessageError() {
  const isError = useMessage((m) => m.status?.type === "incomplete" && m.status.reason === "error");
  if (!isError) return null;
  return (
    <ErrorPrimitive.Root className="border-destructive/40 bg-destructive/10 text-destructive mt-2 rounded-md border px-3 py-2 text-sm">
      <ErrorPrimitive.Message />
    </ErrorPrimitive.Root>
  );
}

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
