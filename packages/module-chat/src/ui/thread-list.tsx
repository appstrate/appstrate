// SPDX-License-Identifier: Apache-2.0

/**
 * Conversation list + the conversation's « … » menu. Plain React Query over
 * the session REST API (no assistant-ui thread-list runtime): the URL is the
 * single source of truth, selection just navigates. Mutations (rename/delete)
 * invalidate the list; the active conversation's first message invalidates it too
 * (see index.tsx) so a new conversation appears here with its server-derived title.
 *
 * Both pieces are mounted by the HOST SHELL, not by `ChatPage`: the list is the
 * chat's navigation (it sits in the shell sidebar, where Studio's nav sits) and
 * the open conversation's « … » sits in the shell header's actions. They read the
 * same two contexts `ChatPage` publishes, so the host renders both below its own
 * `ChatTransportProvider` / `SelectConversationProvider`, and they share the
 * thread's React Query key, so one request feeds all of it. A row and the header
 * open the same menu (`ConversationActionsMenu`): the trail shows the name, it does
 * not edit it.
 *
 * The list renders into the host's sidebar (a `SidebarProvider` must be above
 * it): it IS the chat's navigation, so it uses the same rows, groups and active
 * fill as Studio's, or the two products would not read as one app.
 */

import { useEffect, useRef, useState, type ReactElement } from "react";
import { flushSync } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  ChevronDownIcon,
  EllipsisIcon,
  MessagesSquareIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { cn } from "@appstrate/ui/cn";
import { useNowTick } from "@appstrate/ui/use-now-tick";
import { Spinner } from "@appstrate/ui/components/spinner";
import { Button } from "@appstrate/ui/components/button";
import { Input } from "@appstrate/ui/components/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@appstrate/ui/components/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@appstrate/ui/components/popover";
import { Label } from "@appstrate/ui/components/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@appstrate/ui/components/dialog";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@appstrate/ui/components/alert-dialog";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarInput,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@appstrate/ui/components/sidebar";
import {
  useChatTransport,
  useSelectConversation,
  type ChatCan,
  type ChatTranslate,
  type RenderSpaces,
} from "./runtime-context.ts";
import {
  renameSession,
  deleteSession,
  dropSessionFromLists,
  sessionQueryKey,
  SESSIONS_QUERY_KEY,
  type SessionSummary,
} from "./sessions.ts";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@appstrate/ui/components/collapsible";
import { readCollapsedGroups, setGroupFolded } from "./collapsed-groups.ts";
import { ConversationGroupSkeleton } from "./conversation-skeleton.tsx";
import { groupSessionsByDate, type SessionGroupKey } from "./session-groups.ts";
import {
  NEW_CONVERSATION_CLASS,
  NEW_CONVERSATION_ICON_CLASS,
  SEARCH_TOGGLE_CLASS,
  NOTE_TEXT_CLASS,
  READING_TEXT_DENSE_CLASS,
  SEARCH_INPUT_CLASS,
} from "./phone-text.ts";
import { useActiveSession, useSessions } from "./use-sessions.ts";

const SEARCH_DEBOUNCE_MS = 250;
const SEARCH_MAX_LENGTH = 200;

const GROUP_LABEL_KEY: Record<SessionGroupKey, string> = {
  today: "threads.group.today",
  yesterday: "threads.group.yesterday",
  week: "threads.group.week",
  month: "threads.group.month",
  older: "threads.group.older",
};

/** The folded date groups: read once on mount, written through on each toggle. */
function useCollapsedGroups() {
  const [collapsed, setCollapsed] = useState(readCollapsedGroups);
  const setFolded = (key: SessionGroupKey, folded: boolean) => {
    const next = setGroupFolded(collapsed, key, folded);
    setCollapsed(next);
  };
  return [collapsed, setFolded] as const;
}

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
 * The chat's navigation, in the host shell's sidebar vocabulary (same groups,
 * rows and active fill as Studio's nav — the two products must read as one
 * app). "Nouvelle conversation" sits ABOVE the group rather than as a discreet
 * "+" beside its label: it is the primary action of the surface, and it is the
 * only row that survives the icon rail, where the conversations themselves
 * cannot be shown.
 *
 * Every row is one line, for a writer as for a reader: the title, then one block
 * on the right — the tiles of the spaces the conversation touched (their names in
 * `title`, and in the row's « … »), then its status when it has one (generating,
 * unread); the « … » takes the whole block's place on hover.
 * The date is the group's (« Aujourd'hui », …), not the row's.
 *
 * A conversation whose reply arrived while the user was elsewhere reads as
 * unread until it is opened; `activeId` is never counted, since looking at it
 * IS reading it.
 *
 * `t` and `can` arrive as props, not from `useChatHost()`: the
 * shell mounts this list outside `ChatPage`, where the host bag is published.
 */
export function ChatConversationList({
  activeId,
  t,
  can,
  renderSpaces,
}: {
  activeId: string | null;
  t: ChatTranslate;
  can: ChatCan;
  /** Names spaces: every row shows the tiles of the spaces its conversation touched. */
  renderSpaces: RenderSpaces;
}) {
  const select = useSelectConversation();
  const [input, setInput] = useState("");
  // On a phone the search is a magnifier beside "New conversation" that unfolds the field; from
  // `md` up the field is always there.
  const [searchOpen, setSearchOpen] = useState(false);
  const searchField = useRef<HTMLInputElement>(null);
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
  const [collapsedGroups, setFolded] = useCollapsedGroups();
  const groups = searching ? [] : groupSessionsByDate(list, new Date(now));
  // Starting a conversation is a write, as are rename and delete; a reader also gets its own empty copy.
  const canWrite = can("chat:write");
  const hasAny = (base.data?.length ?? 0) > 0;
  // Shown while the list loads too, as most lists have rows: the rows must not move down on load.
  const showSearch = base.isLoading || hasAny || input !== "";
  // Gone once the field shows: it carries its own magnifier.
  const showSearchToggle = showSearch && !searchOpen && input === "";

  const row = (s: SessionSummary) => (
    <ConversationRow
      key={s.id}
      session={s}
      active={s.id === activeId}
      unread={s.unread && s.id !== activeId}
      t={t}
      canWrite={canWrite}
      renderSpaces={renderSpaces}
    />
  );
  return (
    <>
      {/* Starting a conversation is a write: a reader only rereads its own, and on a phone still
          gets the magnifier that unfolds the search. */}
      {(canWrite || showSearchToggle) && (
        <SidebarGroup className={cn("pb-0", !canWrite && "md:hidden")}>
          <SidebarMenu>
            <SidebarMenuItem>
              {canWrite && (
                <SidebarMenuButton
                  onClick={() => select?.(null)}
                  tooltip={t("threads.new")}
                  className={cn(NEW_CONVERSATION_CLASS, showSearch && "max-md:pr-12")}
                >
                  {/* A phone's row has its icon in a round tile, as the rows below it have theirs. */}
                  <span className={NEW_CONVERSATION_ICON_CLASS}>
                    <PlusIcon />
                  </span>
                  <span>{t("threads.new")}</span>
                </SidebarMenuButton>
              )}
              {showSearchToggle && (
                <button
                  type="button"
                  aria-label={t("threads.search.open")}
                  data-testid="chat-search-toggle"
                  onClick={() => {
                    // The field is hidden until this state lands: commit it now so the focus stays
                    // inside the tap, the only place iOS opens the keyboard from.
                    flushSync(() => setSearchOpen(true));
                    searchField.current?.focus();
                  }}
                  className={cn(
                    SEARCH_TOGGLE_CLASS,
                    "active:bg-sidebar-accent",
                    canWrite ? "absolute top-0 right-0" : "ml-auto",
                  )}
                >
                  <SearchIcon className="size-5" />
                </button>
              )}
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
      )}
      {showSearch && (
        <div
          className={cn(
            "relative px-2 pt-2 pb-1 group-data-[collapsible=icon]:hidden",
            !searchOpen && input === "" && "max-md:hidden",
          )}
        >
          <SearchIcon className="text-sidebar-foreground/50 pointer-events-none absolute top-1/2 left-4 size-3.5 -translate-y-1/2 max-md:left-6 max-md:size-4" />
          <SidebarInput
            ref={searchField}
            type="search"
            value={input}
            maxLength={SEARCH_MAX_LENGTH}
            placeholder={t("threads.search.placeholder")}
            aria-label={t("threads.search.placeholder")}
            onChange={(event) => setInput(event.target.value)}
            // An empty field folds back into its magnifier on a phone.
            onBlur={() => input === "" && setSearchOpen(false)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && input !== "") {
                event.preventDefault();
                setInput("");
              }
            }}
            className={SEARCH_INPUT_CLASS}
          />
          {/* Clears the field; on a phone it also folds it back into its magnifier, and stays there
              to close an empty one. */}
          {(input !== "" || searchOpen) && (
            <button
              type="button"
              aria-label={t(input !== "" ? "threads.search.clear" : "threads.search.close")}
              title={t(input !== "" ? "threads.search.clear" : "threads.search.close")}
              data-testid="chat-search-clear"
              onClick={() => {
                setInput("");
                setSearchOpen(false);
              }}
              className={cn(
                "text-sidebar-foreground/70 hover:text-sidebar-foreground absolute top-1/2 right-3.5 -translate-y-1/2 rounded-md p-0.5 max-md:right-1 max-md:p-3.5",
                input === "" && "md:hidden",
              )}
            >
              <XIcon className="size-3.5 max-md:size-4" />
            </button>
          )}
        </div>
      )}
      <SidebarGroup
        className={cn("min-h-0 flex-1 group-data-[collapsible=icon]:hidden", showSearch && "pt-0")}
      >
        {(searching || (!isLoading && groups.length === 0)) && (
          <SidebarGroupLabel className={NOTE_TEXT_CLASS}>
            {t(searching ? "threads.results" : "threads.title")}
          </SidebarGroupLabel>
        )}
        {/* Grows only with rows to scroll: an empty list must not push its
            empty state to the bottom of the sidebar. The negative margins
            stretch the scroll box over the group's padding to the sidebar's
            edges, as Studio's nav scrolls; `w-auto` lets `-mr-2` widen it.
            `scroll-fade-y` fades the edge that hides rows, as the dashboard's
            agent row does sideways. */}
        <SidebarMenu
          className={
            list.length > 0 || isLoading
              ? "scroll-fade-y -mr-2 -mb-2 min-h-0 w-auto flex-1 overflow-y-auto pr-2 pb-2"
              : undefined
          }
        >
          {isLoading && <ConversationGroupSkeleton dated={!searching} />}
          {searching
            ? list.map(row)
            : groups.map((group) => {
                const folded = collapsedGroups.has(group.key);
                const active = folded ? group.sessions.find((s) => s.id === activeId) : undefined;
                return (
                  <Collapsible
                    key={group.key}
                    render={<li className="flex flex-col gap-1" />}
                    open={!folded}
                    onOpenChange={(open) => setFolded(group.key, !open)}
                  >
                    <SidebarGroupLabel
                      render={<CollapsibleTrigger />}
                      className="group/label desktop-pointer:hover:bg-sidebar-accent desktop-pointer:hover:text-sidebar-accent-foreground desktop-pointer:h-6 desktop-pointer:text-[11px] mt-1 h-10 justify-start gap-1 px-2 text-left text-sm [&>svg]:size-3"
                    >
                      {t(GROUP_LABEL_KEY[group.key])}
                      <ChevronDownIcon
                        aria-hidden
                        className="-rotate-90 transition-transform group-data-panel-open/label:rotate-0"
                      />
                    </SidebarGroupLabel>
                    <CollapsibleContent render={<ul className="flex flex-col gap-1" />}>
                      {group.sessions.map(row)}
                    </CollapsibleContent>
                    {/* A folded group still shows the open conversation, alone under its heading. */}
                    {active && <ul className="flex flex-col gap-1">{row(active)}</ul>}
                  </Collapsible>
                );
              })}
          {/* A plain button, not a menu row: a menu row closes the phone's
              drawer, and loading more must leave it open on the list. */}
          {hasNextPage && (
            <SidebarMenuItem>
              <button
                type="button"
                disabled={isFetchingNextPage}
                onClick={() => void fetchNextPage()}
                className="text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-sidebar-ring flex h-7 w-full items-center rounded-md px-2 text-left text-base outline-none focus-visible:ring-2 disabled:opacity-50 md:text-xs"
              >
                {isFetchingNextPage && <Spinner className="mr-1.5 size-3" />}
                {t("threads.showMore")}
              </button>
            </SidebarMenuItem>
          )}
        </SidebarMenu>
        {isError && list.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-2 py-6 text-center">
            <p className={`text-sidebar-foreground/70 ${READING_TEXT_DENSE_CLASS}`}>
              {t("threads.error")}
            </p>
            <Button type="button" variant="outline" size="sm" onClick={() => void refetch()}>
              {t("common:btn.retry")}
            </Button>
          </div>
        )}
        {!isLoading && !isError && list.length === 0 && searching && (
          <p
            className={`text-sidebar-foreground/70 px-2 py-6 text-center ${READING_TEXT_DENSE_CLASS}`}
          >
            {t("threads.noResults")}
          </p>
        )}
        {!isLoading && !isError && list.length === 0 && !searching && (
          <div className="flex flex-col items-center gap-2 px-2 py-6 text-center">
            <MessagesSquareIcon className="text-sidebar-foreground/50 size-6" />
            <p className={`text-sidebar-foreground/70 ${READING_TEXT_DENSE_CLASS}`}>
              {t(canWrite ? "threads.empty" : "threads.emptyReadOnly")}
            </p>
          </div>
        )}
      </SidebarGroup>
    </>
  );
}

function ConversationRow({
  session,
  active,
  unread,
  t,
  canWrite,
  renderSpaces,
}: {
  session: SessionSummary;
  active: boolean;
  unread: boolean;
  t: ChatTranslate;
  canWrite: boolean;
  renderSpaces: RenderSpaces;
}) {
  const select = useSelectConversation();

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={active}
        onClick={() => select?.(session.id)}
        size="lg"
        // One line: a thumb's 48px on touch, Studio's 32px rows under a mouse. On touch the « … » is
        // always there, at the right of the row: the padding keeps the row clear of it.
        // The host's space tiles ring themselves in `--tile-ring`: the row's background in each
        // of its states.
        className={cn(
          "desktop-pointer:h-8 desktop-pointer:pr-2 pr-11",
          "[--tile-ring:var(--sidebar)] hover:[--tile-ring:var(--sidebar-accent)] active:[--tile-ring:var(--sidebar-accent)] data-[active=true]:[--tile-ring:var(--sidebar-accent)]",
        )}
      >
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span
            className={cn(
              "block min-w-0 flex-1 truncate text-left leading-4 max-md:text-base max-md:leading-5",
              unread && "font-semibold",
            )}
          >
            {session.title ?? t("threads.new")}
          </span>
          {/* The right side, one block: the tiles of the spaces it touched, then its status when
              it has one (generating, unread). Under a mouse the « … » takes the place of the whole
              block on hover, on focus and while its popup is open, so the block is at least as
              wide as the « … ». */}
          <span
            data-testid="chat-session-trailing"
            className="desktop-pointer:min-w-6 desktop-pointer:group-hover/menu-item:opacity-0 desktop-pointer:group-focus-within/menu-item:opacity-0 desktop-pointer:group-has-[[data-popup-open]]/menu-item:opacity-0 flex shrink-0 items-center justify-end gap-2 transition-opacity"
          >
            {session.space_ids.length > 0 && (
              <span data-testid="chat-session-space-tiles" className="flex items-center">
                {renderSpaces(session.space_ids, { tilesOnly: true })}
              </span>
            )}
            {session.generating ? (
              <Spinner
                data-testid="chat-session-status"
                className="text-sidebar-foreground/70 size-3.5"
                aria-label={t("threads.generating")}
              />
            ) : (
              unread && (
                <span
                  data-testid="chat-session-status"
                  className="bg-primary size-2 rounded-full"
                  aria-label={t("threads.unread")}
                  title={t("threads.unread")}
                />
              )
            )}
          </span>
        </span>
      </SidebarMenuButton>
      {/* One « … », the same items on every format: always there and a thumb's size on touch,
          revealed by hover or focus under a mouse. A reader's names the spaces alone. */}
      <ConversationActionsMenu
        session={session}
        active={active}
        t={t}
        canWrite={canWrite}
        renderSpaces={renderSpaces}
      >
        <button
          type="button"
          aria-label={t(canWrite ? "threads.actions.openFor" : "threads.actions.spacesFor", {
            title: session.title ?? t("threads.new"),
          })}
          className="text-sidebar-foreground/70 active:bg-sidebar-accent desktop-pointer:top-1 desktop-pointer:right-2 desktop-pointer:size-6 desktop-pointer:opacity-0 desktop-pointer:group-hover/menu-item:opacity-100 desktop-pointer:group-focus-within/menu-item:opacity-100 desktop-pointer:data-popup-open:opacity-100 desktop-pointer:hover:bg-sidebar-border desktop-pointer:hover:text-sidebar-foreground absolute top-0 right-0 flex h-12 w-11 items-center justify-center rounded-md transition-opacity"
        >
          <EllipsisIcon className="desktop-pointer:size-3.5 size-5" />
        </button>
      </ConversationActionsMenu>
    </SidebarMenuItem>
  );
}

/** The classes of the element holding a conversation's spaces, in a menu's label or a popover. */
const CONVERSATION_SPACES_CLASS = cn(
  "text-muted-foreground flex min-w-0 items-center font-normal [--tile-ring:var(--popover)] max-md:[--tile-ring:var(--background)]",
  NOTE_TEXT_CLASS,
);

/** The spaces a conversation reaches, by name; the caller wraps them. */
function ConversationSpaces({
  session,
  t,
  renderSpaces,
}: {
  session: SessionSummary;
  t: ChatTranslate;
  renderSpaces: RenderSpaces;
}) {
  // A row shows their tiles alone, and a touch has no hover to read their `title`.
  return session.space_ids.length > 0
    ? renderSpaces(session.space_ids)
    : t("common:overview.title");
}

/**
 * A conversation's « … »: the spaces it reaches, then for a writer « Renommer » and « Supprimer »,
 * for a row and for the open conversation in the host's header alike. A reader's opens a popover
 * with the spaces alone. `children` is the trigger. Below
 * `md` the menu is a panel from the bottom, titled by the conversation. Deleting the `active`
 * conversation leaves it for a new one.
 */
function ConversationActionsMenu({
  session,
  active,
  t,
  canWrite,
  renderSpaces,
  children,
}: {
  session: SessionSummary;
  active: boolean;
  t: ChatTranslate;
  /** Renaming and deleting are writes: a reader's menu names the spaces alone. */
  canWrite: boolean;
  renderSpaces: RenderSpaces;
  children: ReactElement;
}) {
  const transport = useChatTransport();
  const select = useSelectConversation();
  const queryClient = useQueryClient();
  const [renaming, setRenaming] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteFailed, setDeleteFailed] = useState(false);
  // Closing a dialog opened from the menu hands the focus back to its trigger. A trigger gone with
  // its deleted conversation takes nothing: the next conversation's composer keeps its autofocus.
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const restoreDialogFocus = () => (menuTrigger.current?.isConnected ? menuTrigger.current : false);
  const title = session.title ?? t("threads.new");

  // The dialog stays open while the delete is in flight and on failure (it says
  // so); it closes only once the conversation is gone.
  const onDelete = async () => {
    if (!transport) return;
    setDeleting(true);
    setDeleteFailed(false);
    try {
      await deleteSession(transport, session.id);
    } catch {
      // Not a `useMutation`, so the app's mutation cache does not toast it: say it in the dialog.
      setDeleteFailed(true);
      setDeleting(false);
      return;
    }
    setConfirmingDelete(false);
    setDeleting(false);
    await dropSessionFromLists(queryClient, session.id);
    if (active) select?.(null);
  };

  return (
    <>
      {canWrite ? (
        <DropdownMenu>
          <DropdownMenuTrigger ref={menuTrigger} render={children} />
          <DropdownMenuContent align="end" className="min-w-40" sheetTitle={title}>
            <DropdownMenuLabel data-testid="chat-menu-spaces" className={CONVERSATION_SPACES_CLASS}>
              <ConversationSpaces session={session} t={t} renderSpaces={renderSpaces} />
            </DropdownMenuLabel>
            <DropdownMenuItem onClick={() => setRenaming(true)}>
              <PencilIcon />
              {t("threads.rename")}
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              onClick={() => {
                setDeleteFailed(false);
                setConfirmingDelete(true);
              }}
            >
              <Trash2Icon />
              {t("common:btn.delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        // A reader has no action: a menu would be empty for assistive tech, so the spaces open
        // in a popover (a panel from the bottom on a phone, as the menu's).
        <Popover>
          <PopoverTrigger render={children} />
          <PopoverContent align="end" className="w-auto min-w-40 p-2">
            <div
              data-testid="chat-menu-spaces"
              className={cn(CONVERSATION_SPACES_CLASS, "px-2 py-1.5")}
            >
              <ConversationSpaces session={session} t={t} renderSpaces={renderSpaces} />
            </div>
          </PopoverContent>
        </Popover>
      )}
      {canWrite && (
        <AlertDialog
          open={confirmingDelete}
          onOpenChange={(open) => !deleting && setConfirmingDelete(open)}
        >
          <AlertDialogContent data-testid="chat-delete-confirm" finalFocus={restoreDialogFocus}>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("threads.delete.title")}</AlertDialogTitle>
              <AlertDialogDescription>
                {t("threads.delete.description", { title })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            {deleteFailed && (
              <p role="alert" className="text-destructive text-sm">
                {t("threads.delete.error")}
              </p>
            )}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deleting}>{t("common:btn.cancel")}</AlertDialogCancel>
              <Button
                type="button"
                variant="destructive"
                disabled={deleting}
                onClick={() => void onDelete()}
              >
                {deleting && <Spinner className="mr-1.5 size-3.5" />}
                {t("common:btn.delete")}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
      {canWrite && renaming && (
        <ConversationRenameDialog
          session={session}
          t={t}
          finalFocus={restoreDialogFocus}
          onClose={() => setRenaming(false)}
        />
      )}
    </>
  );
}

/**
 * The open conversation's « … » in the host's header, on every format: the same menu as its row.
 * Renders nothing until the conversation is stored. A reader gets it too, with the spaces alone
 * (renaming and deleting are writes). The conversation is read like the trail reads it, so one
 * opened outside the list's filter has it too.
 */
export function ChatConversationMenu({
  activeId,
  t,
  can,
  renderSpaces,
}: {
  activeId: string | null;
  t: ChatTranslate;
  can: ChatCan;
  renderSpaces: RenderSpaces;
}) {
  const transport = useChatTransport() ?? undefined;
  const session = useActiveSession(transport, activeId ?? "", activeId !== null);
  if (!session) return null;
  const canWrite = can("chat:write");
  // Named after what it opens: a reader's lists the spaces alone.
  const label = t(canWrite ? "threads.actions.conversation" : "threads.actions.spaces");
  return (
    <ConversationActionsMenu
      key={session.id}
      session={session}
      active
      t={t}
      canWrite={canWrite}
      renderSpaces={renderSpaces}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={label}
        title={label}
        data-testid="chat-conversation-menu"
      >
        <EllipsisIcon className="size-4" />
      </Button>
    </ConversationActionsMenu>
  );
}

/**
 * Renaming the conversation: its name, saved explicitly (« Renommer » or Enter),
 * never on blur. The dialog stays open on a refusal and says so: the chat's own
 * fetch is not toasted by the app's mutation cache.
 */
function ConversationRenameDialog({
  session,
  t,
  onClose,
  finalFocus,
}: {
  session: SessionSummary;
  t: ChatTranslate;
  onClose: () => void;
  finalFocus?: () => HTMLElement | boolean;
}) {
  const transport = useChatTransport();
  const queryClient = useQueryClient();
  const current = session.title ?? "";
  const [value, setValue] = useState(current);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const next = value.trim();
  const dirty = next !== "" && next !== current;

  const save = async () => {
    if (!transport || saving || !dirty) return;
    setSaving(true);
    setFailed(false);
    try {
      await renameSession(transport, session.id, next);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: sessionQueryKey(transport.orgId, session.id) }),
      ]);
      onClose();
    } catch {
      setFailed(true);
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent finalFocus={finalFocus}>
        <DialogHeader>
          <DialogTitle>{t("threads.renameDialog.title")}</DialogTitle>
          <DialogDescription>{t("threads.renameDialog.description")}</DialogDescription>
        </DialogHeader>
        <form
          id="chat-conversation-rename"
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <Label htmlFor="chat-conversation-name">{t("threads.renameDialog.name")}</Label>
          <Input
            id="chat-conversation-name"
            autoFocus
            value={value}
            placeholder={t("threads.new")}
            disabled={saving}
            onChange={(event) => setValue(event.target.value)}
          />
          {failed && (
            <p role="alert" className="text-destructive text-sm">
              {t("common:saveFeedback.error")}
            </p>
          )}
        </form>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={saving} onClick={onClose}>
            {t("common:btn.cancel")}
          </Button>
          <Button type="submit" form="chat-conversation-rename" disabled={saving || !dirty}>
            {saving && <Spinner className="mr-1.5 size-3.5" />}
            {t("threads.rename")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
