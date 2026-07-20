// SPDX-License-Identifier: Apache-2.0

/**
 * Conversation list + active-conversation title. Plain React Query over the
 * session REST API (no assistant-ui thread-list runtime): the URL is the single
 * source of truth, selection just navigates. Mutations (rename/delete) invalidate
 * the list; the active conversation's first message invalidates it too (see
 * index.tsx) so a new conversation appears here with its server-derived title.
 */

import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { PlusIcon, PencilIcon, Trash2Icon, Loader2Icon } from "lucide-react";
import { useChatHeaders, useSelectConversation } from "./runtime-context.ts";
import {
  renameSession,
  deleteSession,
  SESSIONS_QUERY_KEY,
  type SessionSummary,
} from "./sessions.ts";
import { useSessions } from "./use-sessions.ts";

/**
 * ISO timestamp → compact relative time ("5 min", "2 h", "3 j"), as of render.
 * `Intl.RelativeTimeFormat` always prefixes "il y a", so we format by hand.
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

export function ThreadList({
  activeId,
  unreadIds,
}: {
  activeId: string | null;
  unreadIds?: ReadonlySet<string>;
}) {
  const select = useSelectConversation();
  const { data: sessions, isLoading } = useSessions();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-1 border-b px-3">
        <span className="flex-1 text-sm font-medium">Conversations</span>
        <button
          type="button"
          aria-label="Nouvelle conversation"
          title="Nouvelle conversation"
          onClick={() => select?.(null)}
          className="text-muted-foreground hover:text-foreground hover:bg-accent rounded-md p-1.5"
        >
          <PlusIcon className="size-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
        {(sessions ?? []).map((s) => (
          <ConversationRow
            key={s.id}
            session={s}
            active={s.id === activeId}
            unread={unreadIds?.has(s.id) ?? false}
          />
        ))}
        {!isLoading && (sessions ?? []).length === 0 && (
          <p className="text-muted-foreground px-2 py-6 text-center text-xs">
            Envoie un message ! Ton historique de conversations apparaîtra ici.
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Inline-rename state + commit, shared by the list row and the header title.
 * Holds the editing toggle and the rename→invalidate mutation in one place so
 * both call sites stay byte-identical.
 */
function useInlineRename(sessionId: string) {
  const getHeaders = useChatHeaders();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const save = async (title: string) => {
    await renameSession(getHeaders, sessionId, title);
    await queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
  };
  return { editing, setEditing, save };
}

function ConversationRow({
  session,
  active,
  unread,
}: {
  session: SessionSummary;
  active: boolean;
  unread: boolean;
}) {
  const getHeaders = useChatHeaders();
  const select = useSelectConversation();
  const queryClient = useQueryClient();
  const { editing, setEditing, save } = useInlineRename(session.id);

  const onDelete = async () => {
    await deleteSession(getHeaders, session.id);
    // Reflect the delete in the cached list. Cancel any in-flight poll first so
    // its stale (pre-delete) response can't land afterwards and resurrect the
    // row; then drop the row. The server is already updated and the periodic
    // poll reconciles any later drift.
    await queryClient.cancelQueries({ queryKey: SESSIONS_QUERY_KEY });
    queryClient.setQueryData<SessionSummary[]>(SESSIONS_QUERY_KEY, (prev) =>
      (prev ?? []).filter((s) => s.id !== session.id),
    );
    if (active) select?.(null);
  };

  if (editing) {
    return (
      <div className="px-2 py-0">
        <RenameInput current={session.title ?? ""} onDone={() => setEditing(false)} onSave={save} />
      </div>
    );
  }

  return (
    <div
      data-active={active || undefined}
      className="group hover:bg-accent/50 data-[active]:bg-accent data-[active]:text-accent-foreground flex items-center gap-1 rounded-md px-2 py-0 text-sm"
    >
      <button
        type="button"
        onClick={() => select?.(session.id)}
        className="flex min-w-0 flex-1 items-center gap-1.5 rounded-none bg-transparent px-0 py-1 text-left text-inherit hover:bg-transparent"
      >
        <span className={`block w-full truncate text-left ${unread ? "font-semibold" : ""}`}>
          {session.title ?? "Nouvelle conversation"}
        </span>
      </button>
      {/* Fixed-width right slot: spinner / unread dot / timestamp have different
          natural widths — without w-14 the title's truncation point reflows on
          every generating↔idle transition. */}
      <div className="relative flex w-14 shrink-0 items-center justify-end">
        {session.generating ? (
          <Loader2Icon
            className="text-muted-foreground size-3.5 animate-spin"
            aria-label="Opération en cours"
          />
        ) : unread ? (
          <span
            className="bg-primary size-2 rounded-full transition-opacity group-hover:opacity-0"
            aria-label="Réponse non lue"
            title="Réponse non lue"
          />
        ) : (
          <span className="text-muted-foreground text-xs transition-opacity group-hover:opacity-0">
            {relativeTime(session.updatedAt)}
          </span>
        )}
        {/* pointer-events must track visibility: opacity-0 alone keeps the
            invisible buttons tappable — on touch devices (no hover) a tap on
            the timestamp area would hit the hidden Delete. */}
        <div className="bg-background pointer-events-none absolute right-0 flex items-center gap-0.5 rounded-md p-0.5 opacity-0 shadow-sm transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
          <button
            type="button"
            aria-label="Renommer"
            title="Renommer"
            onClick={() => setEditing(true)}
            className="text-muted-foreground hover:text-foreground hover:bg-accent rounded-md p-0.5"
          >
            <PencilIcon className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label="Supprimer"
            title="Supprimer"
            onClick={() => void onDelete()}
            className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-md p-0.5"
          >
            <Trash2Icon className="size-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

/** Active-conversation title + rename for the chat header. */
export function ActiveConversationTitle({ activeId }: { activeId: string | null }) {
  const { editing, setEditing, save } = useInlineRename(activeId ?? "");
  const { data: sessions } = useSessions();
  if (!activeId) return null;
  const session = sessions?.find((s) => s.id === activeId);
  if (!session) return null;

  if (editing) {
    return (
      <RenameInput current={session.title ?? ""} onDone={() => setEditing(false)} onSave={save} />
    );
  }
  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className="hover:bg-accent flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5"
      title="Renommer"
    >
      <span className="truncate text-sm font-medium">
        {session.title ?? "Nouvelle conversation"}
      </span>
      <PencilIcon className="text-muted-foreground size-3.5 shrink-0" />
    </button>
  );
}

/** Inline title editor — commits on Enter/blur, cancels on Escape. */
function RenameInput({
  current,
  onDone,
  onSave,
}: {
  current: string;
  onDone: () => void;
  onSave: (title: string) => Promise<void>;
}) {
  const [value, setValue] = useState(current);
  const done = useRef(false);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    const next = value.trim();
    if (save && next && next !== current) void onSave(next);
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
