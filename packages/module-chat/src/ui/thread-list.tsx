// SPDX-License-Identifier: Apache-2.0

/** Conversation list — native assistant-ui thread-list primitives. */

import { useRef, useState } from "react";
import {
  ThreadListPrimitive,
  ThreadListItemPrimitive,
  ThreadListItemMorePrimitive,
  ThreadListItemRuntimeProvider,
  useAssistantRuntime,
  useThreadListItem,
  useThreadListItemRuntime,
} from "@assistant-ui/react";
import {
  PlusIcon,
  SearchIcon,
  PencilIcon,
  Trash2Icon,
  EllipsisVerticalIcon,
  ChevronDownIcon,
} from "lucide-react";

/**
 * ISO timestamp → compact relative time ("5 min", "2 h", "3 j"), as of render.
 * `Intl.RelativeTimeFormat` always prefixes "il y a", so we format by hand for
 * a tighter sidebar label.
 */
function relativeTime(iso: string): string {
  const sec = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (Number.isNaN(sec)) return "";
  if (sec < 60) return "à l'instant";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min`;
  const hour = Math.round(min / 60);
  if (hour < 24) return `${hour} h`;
  const day = Math.round(hour / 24);
  if (day < 30) return `${day} j`;
  const month = Math.round(day / 30);
  if (month < 12) return `${month} mois`;
  const year = Math.round(day / 365);
  return `${year} an${year > 1 ? "s" : ""}`;
}

/** Last-activity time, read from the thread item's native `custom` metadata. */
function Timestamp({ className = "" }: { className?: string }) {
  const updatedAt = useThreadListItem((s) => s.custom?.updatedAt as string | undefined);
  const label = updatedAt ? relativeTime(updatedAt) : "";
  return label ? <span className={className}>{label}</span> : null;
}

export function ThreadList() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header — same height (h-12) + bottom border as the chat and agent
          panels, so the three columns share one aligned header band. */}
      <div className="flex h-12 shrink-0 items-center gap-1 border-b px-3">
        <span className="flex-1 text-sm font-medium">Conversations</span>
        {/* Search is prepared for a future "search past conversations" feature
            — assistant-ui/AI SDK expose no native thread search, so the icon is
            a placeholder until a search path (backend or client filter) lands. */}
        <button
          type="button"
          aria-label="Rechercher dans les conversations (bientôt)"
          title="Rechercher dans les conversations (bientôt)"
          className="text-muted-foreground hover:text-foreground hover:bg-accent rounded-md p-1.5"
        >
          <SearchIcon className="size-4" />
        </button>
        <ThreadListPrimitive.New asChild>
          <button
            type="button"
            aria-label="Nouvelle conversation"
            title="Nouvelle conversation"
            className="text-muted-foreground hover:text-foreground hover:bg-accent rounded-md p-1.5"
          >
            <PlusIcon className="size-4" />
          </button>
        </ThreadListPrimitive.New>
      </div>
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
        <ThreadListPrimitive.Items components={{ ThreadListItem }} />
      </div>
    </div>
  );
}

function ThreadListItem() {
  const [editing, setEditing] = useState(false);
  return (
    <ThreadListItemPrimitive.Root className="group hover:bg-accent/50 data-[active]:bg-accent data-[active]:text-accent-foreground flex items-center gap-1 rounded-md px-2 py-0 text-sm">
      {editing ? (
        <RenameInput onDone={() => setEditing(false)} />
      ) : (
        <>
          <ThreadListItemPrimitive.Trigger className="min-w-0 flex-1 py-1">
            <span className="block w-full truncate text-left">
              <ThreadListItemPrimitive.Title fallback="Nouvelle conversation" />
            </span>
          </ThreadListItemPrimitive.Trigger>
          {/* Trailing slot: relative time at rest, kebab over it on hover
              (and kept visible while the menu is open) — Claude/ChatGPT style. */}
          <div className="relative flex shrink-0 items-center">
            <Timestamp className="text-muted-foreground text-xs transition-opacity group-hover:opacity-0" />
            <ConversationMenu
              onRename={() => setEditing(true)}
              triggerClass="absolute right-0 opacity-0 transition-opacity group-hover:opacity-100 data-[state=open]:opacity-100"
            />
          </div>
        </>
      )}
    </ThreadListItemPrimitive.Root>
  );
}

/**
 * Active-conversation title + actions for the chat header (Claude/Codex style).
 * Binds to the thread list's `mainItem` runtime so the same primitives (Title,
 * rename, delete, kebab) work for the open conversation.
 */
export function ActiveConversationTitle() {
  const runtime = useAssistantRuntime();
  return (
    <ThreadListItemRuntimeProvider runtime={runtime.threads.mainItem}>
      <ActiveTitleInner />
    </ThreadListItemRuntimeProvider>
  );
}

function ActiveTitleInner() {
  const [editing, setEditing] = useState(false);
  if (editing) return <RenameInput onDone={() => setEditing(false)} />;
  return (
    <div className="flex min-w-0 items-center gap-1">
      <span className="truncate text-sm font-medium">
        <ThreadListItemPrimitive.Title fallback="Nouvelle conversation" />
      </span>
      <ConversationMenu onRename={() => setEditing(true)} chevron />
    </div>
  );
}

// ─── Shared kebab menu (list + header) ───────────────────────────────────────

/** Native dropdown (radix, via assistant-ui) with Rename + Delete. */
function ConversationMenu({
  onRename,
  triggerClass = "",
  chevron = false,
}: {
  onRename: () => void;
  triggerClass?: string;
  chevron?: boolean;
}) {
  return (
    <ThreadListItemMorePrimitive.Root>
      <ThreadListItemMorePrimitive.Trigger asChild>
        <button
          type="button"
          aria-label="Actions"
          className={`text-muted-foreground hover:text-foreground hover:bg-accent shrink-0 rounded-md p-1 ${triggerClass}`}
        >
          {chevron ? (
            <ChevronDownIcon className="size-4" />
          ) : (
            <EllipsisVerticalIcon className="size-4" />
          )}
        </button>
      </ThreadListItemMorePrimitive.Trigger>
      <ThreadListItemMorePrimitive.Content
        align="start"
        sideOffset={4}
        className="bg-popover text-popover-foreground z-50 min-w-40 rounded-md border p-1 shadow-md"
      >
        <ThreadListItemMorePrimitive.Item
          onSelect={onRename}
          className="hover:bg-accent flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none"
        >
          <PencilIcon className="size-4" /> Renommer
        </ThreadListItemMorePrimitive.Item>
        <ThreadListItemMorePrimitive.Separator className="bg-border my-1 h-px" />
        <ThreadListItemPrimitive.Delete asChild>
          <ThreadListItemMorePrimitive.Item className="text-destructive hover:bg-destructive/10 flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none">
            <Trash2Icon className="size-4" /> Supprimer
          </ThreadListItemMorePrimitive.Item>
        </ThreadListItemPrimitive.Delete>
      </ThreadListItemMorePrimitive.Content>
    </ThreadListItemMorePrimitive.Root>
  );
}

/** Inline title editor — commits on Enter/blur, cancels on Escape. */
function RenameInput({ onDone }: { onDone: () => void }) {
  const runtime = useThreadListItemRuntime();
  const current = useThreadListItem((s) => s.title) ?? "";
  const [value, setValue] = useState(current);
  // Enter and blur both fire — guard so we commit (and unmount) only once.
  const done = useRef(false);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    const next = value.trim();
    if (save && next && next !== current) void runtime.rename(next);
    onDone();
  };
  return (
    <input
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
      }}
      className="bg-background focus-visible:ring-ring min-w-0 flex-1 rounded-sm border px-1.5 py-0.5 text-sm outline-none focus-visible:ring-1"
    />
  );
}
