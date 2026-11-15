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
 * the title is where-you-are (it sits in the shell breadcrumb). They read the
 * same two contexts `ChatPage` publishes, so the host renders both below its own
 * `ChatHeadersProvider` / `SelectConversationProvider` — the title is portalled
 * into the breadcrumb from there — and they share the thread's React Query key,
 * so one request feeds all of it.
 *
 * The list renders into the host's sidebar (a `SidebarProvider` must be above
 * it): it IS the chat's navigation, so it uses the same rows, groups and active
 * fill as Studio's, or the two products would not read as one app.
 */

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  MessagesSquareIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { relativeAge } from "@appstrate/core/format";
import { Spinner } from "@appstrate/ui/components/spinner";
import { Button } from "@appstrate/ui/components/button";
import { Input } from "@appstrate/ui/components/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@appstrate/ui/components/dialog";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarInput,
  SidebarMenu,
  SidebarMenuSkeleton,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@appstrate/ui/components/sidebar";
import {
  useChatHeaders,
  useSelectConversation,
  type ChatCan,
  type ChatTranslate,
} from "./runtime-context.ts";
import {
  renameSession,
  deleteSession,
  patchSessionsCache,
  sessionsQueryKey,
  spaceIdFromHeaders,
  SESSIONS_QUERY_KEY,
  type SessionsCache,
  type SessionSummary,
} from "./sessions.ts";
import { groupSessionsByDate, type SessionGroupKey } from "./session-groups.ts";
import { useSessions } from "./use-sessions.ts";

const SEARCH_DEBOUNCE_MS = 250;
const SEARCH_MAX_LENGTH = 200;

const GROUP_LABEL_KEY: Record<SessionGroupKey, string> = {
  today: "threads.group.today",
  yesterday: "threads.group.yesterday",
  week: "threads.group.week",
  month: "threads.group.month",
  older: "threads.group.older",
};

/** The trimmed search term, settled `delay` ms after the last keystroke (cleared at once). */
function useDebouncedTerm(input: string, delay: number): string {
  const term = input.trim();
  const [settled, setSettled] = useState(term);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(term), delay);
    return () => clearTimeout(timer);
  }, [term, delay]);
  return term === "" ? "" : settled;
}

/**
 * ISO timestamp → compact relative time ("5 min", "2 h", "3 j"), as of `now`.
 * `Intl.RelativeTimeFormat` always prefixes "il y a" / "ago", three words more
 * than a 56px column holds, so the unit comes from the bundle (plural rules
 * included) and only the number is computed here.
 */
const AGE_KEY = {
  now: "threads.age.now",
  minute: "threads.age.minutes",
  hour: "threads.age.hours",
  day: "threads.age.days",
  month: "threads.age.months",
  year: "threads.age.years",
} as const;

function relativeTime(iso: string, now: number, t: ChatTranslate): string {
  const age = relativeAge(iso, now);
  return age ? t(AGE_KEY[age.unit], { count: age.count }) : "";
}

/**
 * Re-render clock for the relative-time labels. Freshness of the list DATA is
 * event-driven (SSE + safety-net refetch), but React Query's structural sharing
 * keeps `data` referentially stable when the payload is unchanged — no
 * re-render, so a label computed at render time would freeze (the "now" label
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
 *
 * `t` and `can` arrive as props, not from `useChatHost()`: the shell mounts
 * this list outside `ChatPage`, where the host bag is published.
 */
export function ChatConversationList({
  activeId,
  t,
  can,
}: {
  activeId: string | null;
  t: ChatTranslate;
  can: ChatCan;
}) {
  const select = useSelectConversation();
  const [input, setInput] = useState("");
  const term = useDebouncedTerm(input, SEARCH_DEBOUNCE_MS);
  const searching = term !== "";
  // The plain list always runs (same key as the nav badge): it decides whether
  // there is anything to search, and it is what the term falls back to.
  const base = useSessions();
  const found = useSessions(undefined, term);
  const {
    data: sessions,
    isLoading,
    isError,
    refetch,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = searching ? found : base;
  const now = useNowTick();
  const list = sessions ?? [];
  const groups = searching ? [] : groupSessionsByDate(list, new Date(now));
  // Rename and delete are writes; a reader also gets its own empty copy.
  const canWrite = can("chat:write");
  const hasAny = (base.data?.length ?? 0) > 0;
  const showSearch = hasAny || input !== "";

  const row = (s: SessionSummary) => (
    <ConversationRow
      key={s.id}
      session={s}
      active={s.id === activeId}
      unread={s.unread && s.id !== activeId}
      now={now}
      t={t}
      canWrite={canWrite}
    />
  );
  return (
    <>
      {/* Starting a conversation is a write: a reader only rereads its own. */}
      {canWrite && (
        <SidebarGroup className="pb-0">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton onClick={() => select?.(null)} tooltip={t("threads.new")}>
                <PlusIcon />
                <span>{t("threads.new")}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
      )}
      <SidebarGroup className="min-h-0 flex-1 group-data-[collapsible=icon]:hidden">
        {showSearch && (
          <div className="relative mb-1">
            <SearchIcon className="text-sidebar-foreground/50 pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2" />
            <SidebarInput
              type="search"
              value={input}
              maxLength={SEARCH_MAX_LENGTH}
              placeholder={t("threads.search.placeholder")}
              aria-label={t("threads.search.placeholder")}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && input !== "") {
                  event.preventDefault();
                  setInput("");
                }
              }}
              className="h-7 pr-7 pl-7 text-xs [&::-webkit-search-cancel-button]:hidden"
            />
            {input !== "" && (
              <button
                type="button"
                aria-label={t("threads.search.clear")}
                title={t("threads.search.clear")}
                onClick={() => setInput("")}
                className="text-sidebar-foreground/70 hover:text-sidebar-foreground absolute top-1/2 right-1.5 -translate-y-1/2 rounded-md p-0.5"
              >
                <XIcon className="size-3.5" />
              </button>
            )}
          </div>
        )}
        {(searching || groups.length === 0) && (
          <SidebarGroupLabel>
            {t(searching ? "threads.results" : "threads.title")}
          </SidebarGroupLabel>
        )}
        <SidebarMenu className="min-h-0 flex-1 overflow-y-auto">
          {isLoading &&
            Array.from({ length: 5 }, (_, i) => (
              <SidebarMenuItem key={i}>
                <SidebarMenuSkeleton />
              </SidebarMenuItem>
            ))}
          {searching
            ? list.map(row)
            : groups.map((group) => (
                <li key={group.key} className="flex flex-col gap-1">
                  <SidebarGroupLabel className="mt-1 h-6 px-2 text-[11px]">
                    {t(GROUP_LABEL_KEY[group.key])}
                  </SidebarGroupLabel>
                  <ul className="flex flex-col gap-1">{group.sessions.map(row)}</ul>
                </li>
              ))}
          {/* A plain button, not a menu row: a menu row closes the phone's
              drawer, and loading more must leave it open on the list. */}
          {hasNextPage && (
            <SidebarMenuItem>
              <button
                type="button"
                disabled={isFetchingNextPage}
                onClick={() => void fetchNextPage()}
                className="text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-sidebar-ring flex h-7 w-full items-center rounded-md px-2 text-left text-xs outline-none focus-visible:ring-2 disabled:opacity-50"
              >
                {isFetchingNextPage && <Spinner className="mr-1.5 size-3" />}
                {t("threads.showMore")}
              </button>
            </SidebarMenuItem>
          )}
        </SidebarMenu>
        {isError && list.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-2 py-6 text-center">
            <p className="text-sidebar-foreground/70 text-xs">{t("threads.error")}</p>
            <Button type="button" variant="outline" size="sm" onClick={() => void refetch()}>
              {t("common:btn.retry")}
            </Button>
          </div>
        )}
        {!isLoading && !isError && list.length === 0 && searching && (
          <p className="text-sidebar-foreground/70 px-2 py-6 text-center text-xs">
            {t("threads.noResults")}
          </p>
        )}
        {!isLoading && !isError && list.length === 0 && !searching && (
          <div className="flex flex-col items-center gap-2 px-2 py-6 text-center">
            <MessagesSquareIcon className="text-sidebar-foreground/50 size-6" />
            <p className="text-sidebar-foreground/70 text-xs">
              {t(canWrite ? "threads.empty" : "threads.emptyReadOnly")}
            </p>
            {canWrite && (
              <Button type="button" variant="outline" size="sm" onClick={() => select?.(null)}>
                {t("threads.new")}
              </Button>
            )}
          </div>
        )}
      </SidebarGroup>
    </>
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
  t,
  canWrite,
}: {
  session: SessionSummary;
  active: boolean;
  unread: boolean;
  now: number;
  t: ChatTranslate;
  canWrite: boolean;
}) {
  const getHeaders = useChatHeaders();
  const select = useSelectConversation();
  const queryClient = useQueryClient();
  const { editing, setEditing, save } = useInlineRename(session.id);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const onDelete = async () => {
    setConfirmingDelete(false);
    await deleteSession(getHeaders, session.id);
    // Reflect the delete in the cached list. Cancel any in-flight poll first so
    // its stale (pre-delete) response can't land afterwards and resurrect the
    // row; then drop the row. The server is already updated and the periodic
    // poll reconciles any later drift.
    await queryClient.cancelQueries({ queryKey: SESSIONS_QUERY_KEY });
    // The prefix reaches the filtered (search) lists as well as the plain one.
    queryClient.setQueriesData<SessionsCache>(
      { queryKey: sessionsQueryKey(spaceIdFromHeaders(getHeaders)) },
      (prev) => patchSessionsCache(prev, (rows) => rows.filter((s) => s.id !== session.id)),
    );
    if (active) select?.(null);
  };

  if (editing) {
    return (
      <SidebarMenuItem className="px-2">
        <RenameInput
          t={t}
          current={session.title ?? ""}
          onDone={() => setEditing(false)}
          onSave={save}
        />
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
          {session.title ?? t("threads.new")}
        </span>
      </SidebarMenuButton>
      {/* Fixed-width right slot: spinner / unread dot / timestamp have different
          natural widths — without w-14 the title's truncation point reflows on
          every generating↔idle transition. Hover swaps them for the row's
          actions; a reader has none, so for them hover changes nothing. */}
      <div
        className={`absolute top-1 right-1 flex h-6 w-14 items-center justify-end rounded-md ${canWrite ? "group-hover/menu-item:bg-sidebar-accent" : ""}`}
      >
        {session.generating ? (
          <Spinner
            className="text-sidebar-foreground/70 size-3.5"
            aria-label={t("threads.generating")}
          />
        ) : unread ? (
          <span
            className={`bg-primary size-2 rounded-full transition-opacity ${canWrite ? "group-hover/menu-item:opacity-0" : ""}`}
            aria-label={t("threads.unread")}
            title={t("threads.unread")}
          />
        ) : (
          <span
            className={`text-sidebar-foreground/70 text-xs transition-opacity ${canWrite ? "group-hover/menu-item:opacity-0" : ""}`}
          >
            {relativeTime(session.updatedAt, now, t)}
          </span>
        )}
        {/* pointer-events must track visibility: opacity-0 alone keeps the
            invisible buttons tappable — on touch devices (no hover) a tap on
            the timestamp area would hit the hidden Delete. */}
        {canWrite && (
          <div className="pointer-events-none absolute right-0 flex items-center gap-0.5 rounded-md p-0.5 opacity-0 transition-opacity group-hover/menu-item:pointer-events-auto group-hover/menu-item:opacity-100">
            <button
              type="button"
              aria-label={t("common:btn.rename")}
              title={t("common:btn.rename")}
              onClick={() => setEditing(true)}
              className="text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-border rounded-md p-0.5"
            >
              <PencilIcon className="size-3.5" />
            </button>
            <button
              type="button"
              aria-label={t("common:btn.delete")}
              title={t("common:btn.delete")}
              onClick={() => setConfirmingDelete(true)}
              className="text-sidebar-foreground/70 hover:text-destructive hover:bg-destructive/10 rounded-md p-0.5"
            >
              <Trash2Icon className="size-3.5" />
            </button>
          </div>
        )}
      </div>
      <Dialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <DialogContent data-testid="chat-delete-confirm">
          <DialogHeader>
            <DialogTitle>{t("threads.delete.title")}</DialogTitle>
            <DialogDescription>
              {t("threads.delete.description", { title: session.title ?? t("threads.new") })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmingDelete(false)}>
              {t("common:btn.cancel")}
            </Button>
            <Button type="button" variant="destructive" onClick={() => void onDelete()}>
              {t("common:btn.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SidebarMenuItem>
  );
}

/**
 * Active-conversation title + rename, for the host's breadcrumb. Renders
 * nothing until the conversation is known — the host publishes the trail
 * segment on the same condition, so an unknown conversation costs no segment
 * rather than a segment with a made-up name.
 */
export function ChatConversationTitle(props: {
  activeId: string | null;
  t: ChatTranslate;
  can: ChatCan;
}) {
  return <ConversationTitle key={props.activeId} {...props} />;
}

function ConversationTitle({
  activeId,
  t,
  can,
}: {
  activeId: string | null;
  t: ChatTranslate;
  can: ChatCan;
}) {
  const { editing, setEditing, save } = useInlineRename(activeId ?? "");
  const { data: sessions } = useSessions();
  if (!activeId) return null;
  const session = sessions?.find((s) => s.id === activeId);
  if (!session) return null;
  const title = session.title ?? t("threads.new");

  // `font-semibold`, like every other last breadcrumb segment: this is where
  // you are, and it carries the same weight in both products. Renaming is a
  // write, so a reader gets the name alone.
  if (!can("chat:write")) {
    return <span className="min-w-0 truncate px-1.5 text-sm font-semibold">{title}</span>;
  }

  if (editing) {
    return (
      <RenameInput
        t={t}
        current={session.title ?? ""}
        onDone={() => setEditing(false)}
        onSave={save}
      />
    );
  }
  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className="hover:bg-accent flex max-w-full min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5"
      title={t("common:btn.rename")}
    >
      <span className="min-w-0 flex-1 truncate text-left text-sm font-semibold">{title}</span>
      <PencilIcon className="text-muted-foreground size-3.5 shrink-0" />
    </button>
  );
}

/** Inline title editor: explicit Save/Enter, Cancel/Escape; blur never writes. */
function RenameInput({
  current,
  onDone,
  onSave,
  t,
}: {
  current: string;
  onDone: () => void;
  onSave: (title: string) => Promise<void>;
  t: ChatTranslate;
}) {
  const [value, setValue] = useState(current);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const next = value.trim();
  const finish = async () => {
    if (saving || !next || next === current) return;
    setSaving(true);
    setFailed(false);
    try {
      await onSave(next);
      onDone();
    } catch {
      // The chat's own fetch is not toasted by the app's mutation cache: say it here.
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
      <Input
        autoFocus
        value={value}
        disabled={saving}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void finish();
          } else if (event.key === "Escape" && !saving) onDone();
        }}
        className="h-7 min-w-0 flex-1 px-1.5 py-0.5"
      />
      <Button
        type="button"
        size="sm"
        disabled={saving || !next || next === current}
        onClick={() => void finish()}
      >
        {t("common:btn.save")}
      </Button>
      <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={onDone}>
        {t("common:btn.cancel")}
      </Button>
      {failed && (
        <p role="alert" className="text-destructive w-full text-xs">
          {t("common:saveFeedback.error")}
        </p>
      )}
    </div>
  );
}
