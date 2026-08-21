// SPDX-License-Identifier: Apache-2.0

/**
 * Conversation list + active-conversation title. Plain React Query over the
 * session REST API (no assistant-ui thread-list runtime): the URL is the single
 * source of truth, selection just navigates. Mutations (rename/delete) invalidate
 * the list; the active conversation's first message invalidates it too (see
 * index.tsx) so a new conversation appears here with its server-derived title.
 *
 * Both pieces are mounted by the HOST SHELL, not by `ChatPage`: the list is the
 * chat's navigation (it sits in the shell sidebar, where Studio's nav sits) and
 * the title is where-you-are (it sits in the shell breadcrumb). They therefore
 * ship as self-contained wrappers — `ChatConversationList` and
 * `ChatConversationTitle` — that carry the same context `ChatPage` publishes,
 * so the host mounts them anywhere in its tree with only `getHeaders` in hand.
 * Both read the SAME React Query key as the thread, so one request feeds all.
 */

import { type ReactNode, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { PlusIcon, PencilIcon, Trash2Icon, Loader2Icon } from "lucide-react";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@appstrate/ui/components/sidebar";
import {
  ChatHeadersProvider,
  SelectConversationProvider,
  useChatHeaders,
  useSelectConversation,
  type GetHeaders,
  type SelectConversation,
} from "./runtime-context.ts";
import {
  renameSession,
  deleteSession,
  SESSIONS_QUERY_KEY,
  type SessionSummary,
} from "./sessions.ts";
import { useSessions } from "./use-sessions.ts";

/**
 * ISO timestamp → compact relative time ("5 min", "2 h", "3 j"), as of `now`.
 * `Intl.RelativeTimeFormat` always prefixes "il y a", so we format by hand.
 */
function relativeTime(iso: string, now: number): string {
  const sec = Math.round((now - new Date(iso).getTime()) / 1000);
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

/**
 * Re-render clock for the relative-time labels. Freshness of the list DATA is
 * event-driven (SSE + safety-net refetch), but React Query's structural sharing
 * keeps `data` referentially stable when the payload is unchanged — no
 * re-render, so a label computed at render time would freeze ("à l'instant"
 * forever on a quiet list). 30s granularity matches the coarsest visible unit.
 */
function useNowTick(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * The chat's navigation, in the host shell's sidebar vocabulary (same groups,
 * rows and active fill as Studio's nav — the two products must read as one
 * app). "Nouvelle conversation" sits ABOVE the group rather than as a discreet
 * "+" beside its label: it is the primary action of the surface, and it is the
 * only row that survives the icon rail, where the conversations themselves
 * cannot be shown.
 *
 * A conversation whose reply arrived while the user was elsewhere reads as
 * unread until it is opened; `activeId` is never counted, since looking at it
 * IS reading it.
 */
function ThreadList({ activeId }: { activeId: string | null }) {
  const select = useSelectConversation();
  const { data: sessions, isLoading } = useSessions();
  const now = useNowTick();
  const list = sessions ?? [];
  return (
    <>
      <SidebarGroup className="pb-0">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={() => select?.(null)} tooltip="Nouvelle conversation">
              <PlusIcon />
              <span>Nouvelle conversation</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroup>
      <SidebarGroup className="min-h-0 flex-1 group-data-[collapsible=icon]:hidden">
        <SidebarGroupLabel>Conversations</SidebarGroupLabel>
        <SidebarMenu className="min-h-0 flex-1 overflow-y-auto">
          {list.map((s) => (
            <ConversationRow
              key={s.id}
              session={s}
              active={s.id === activeId}
              unread={s.unread && s.id !== activeId}
              now={now}
            />
          ))}
        </SidebarMenu>
        {!isLoading && list.length === 0 && (
          <p className="text-sidebar-foreground/70 px-2 py-6 text-center text-xs">
            Envoie un message ! Ton historique de conversations apparaîtra ici.
          </p>
        )}
      </SidebarGroup>
    </>
  );
}

/**
 * The list, mounted by the host in its sidebar. Self-contained: it carries the
 * same two contexts `ChatPage` publishes, so the host needs only `getHeaders`
 * and its own navigation callback — the sessions query key is shared, so this
 * and the thread issue ONE request between them.
 */
export function ChatConversationList({
  getHeaders,
  activeId,
  onConversationChange,
}: {
  getHeaders?: GetHeaders;
  activeId: string | null;
  onConversationChange?: SelectConversation;
}) {
  return (
    <ChatProviders getHeaders={getHeaders} onConversationChange={onConversationChange}>
      <ThreadList activeId={activeId} />
    </ChatProviders>
  );
}

/** The active conversation's title, mounted by the host in its breadcrumb. */
export function ChatConversationTitle({
  getHeaders,
  activeId,
}: {
  getHeaders?: GetHeaders;
  activeId: string | null;
}) {
  return (
    <ChatProviders getHeaders={getHeaders}>
      <ActiveConversationTitle activeId={activeId} />
    </ChatProviders>
  );
}

function ChatProviders({
  getHeaders,
  onConversationChange,
  children,
}: {
  getHeaders?: GetHeaders;
  onConversationChange?: SelectConversation;
  children: ReactNode;
}) {
  return (
    <ChatHeadersProvider value={getHeaders ?? null}>
      <SelectConversationProvider value={onConversationChange ?? null}>
        {children}
      </SelectConversationProvider>
    </ChatHeadersProvider>
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
  now,
}: {
  session: SessionSummary;
  active: boolean;
  unread: boolean;
  now: number;
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
      <SidebarMenuItem className="px-2">
        <RenameInput current={session.title ?? ""} onDone={() => setEditing(false)} onSave={save} />
      </SidebarMenuItem>
    );
  }

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={active}
        onClick={() => select?.(session.id)}
        // Room for the fixed-width right slot below, which is absolutely
        // positioned and would otherwise sit on top of a long title.
        className="pr-16"
      >
        <span className={`block w-full truncate text-left ${unread ? "font-semibold" : ""}`}>
          {session.title ?? "Nouvelle conversation"}
        </span>
      </SidebarMenuButton>
      {/* Fixed-width right slot: spinner / unread dot / timestamp have different
          natural widths — without w-14 the title's truncation point reflows on
          every generating↔idle transition. */}
      <div className="group-hover/menu-item:bg-sidebar-accent absolute top-1 right-1 flex h-6 w-14 items-center justify-end rounded-md">
        {session.generating ? (
          <Loader2Icon
            className="text-sidebar-foreground/70 size-3.5 animate-spin"
            aria-label="Opération en cours"
          />
        ) : unread ? (
          <span
            className="bg-primary size-2 rounded-full transition-opacity group-hover/menu-item:opacity-0"
            aria-label="Réponse non lue"
            title="Réponse non lue"
          />
        ) : (
          <span className="text-sidebar-foreground/70 text-xs transition-opacity group-hover/menu-item:opacity-0">
            {relativeTime(session.updatedAt, now)}
          </span>
        )}
        {/* pointer-events must track visibility: opacity-0 alone keeps the
            invisible buttons tappable — on touch devices (no hover) a tap on
            the timestamp area would hit the hidden Delete. */}
        <div className="pointer-events-none absolute right-0 flex items-center gap-0.5 rounded-md p-0.5 opacity-0 transition-opacity group-hover/menu-item:pointer-events-auto group-hover/menu-item:opacity-100">
          <button
            type="button"
            aria-label="Renommer"
            title="Renommer"
            onClick={() => setEditing(true)}
            className="text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-border rounded-md p-0.5"
          >
            <PencilIcon className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label="Supprimer"
            title="Supprimer"
            onClick={() => void onDelete()}
            className="text-sidebar-foreground/70 hover:text-destructive hover:bg-destructive/10 rounded-md p-0.5"
          >
            <Trash2Icon className="size-3.5" />
          </button>
        </div>
      </div>
    </SidebarMenuItem>
  );
}

/** Active-conversation title + rename for the shell breadcrumb. */
function ActiveConversationTitle({ activeId }: { activeId: string | null }) {
  const { editing, setEditing, save } = useInlineRename(activeId ?? "");
  const { data: sessions } = useSessions();
  if (!activeId) return null;
  const session = sessions?.find((s) => s.id === activeId);
  // The list has not arrived yet, or the URL names a conversation that is gone.
  // Still render the segment: the host has already drawn the separator before
  // it, and a trail that ends on a lone "/" reads as a broken page. Not
  // renameable — there is nothing known to rename.
  if (!session) return <span className="truncate text-sm font-medium">Nouvelle conversation</span>;

  if (editing) {
    return (
      <RenameInput current={session.title ?? ""} onDone={() => setEditing(false)} onSave={save} />
    );
  }
  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className="hover:bg-accent flex max-w-full min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5"
      title="Renommer"
    >
      <span className="min-w-0 flex-1 truncate text-left text-sm font-medium">
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
