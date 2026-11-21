// SPDX-License-Identifier: Apache-2.0

/**
 * Conversation list + the conversation's settings dialog. Plain React Query over
 * the session REST API (no assistant-ui thread-list runtime): the URL is the
 * single source of truth, selection just navigates. Mutations (rename/delete)
 * invalidate the list; the active conversation's first message invalidates it too
 * (see index.tsx) so a new conversation appears here with its server-derived title.
 *
 * Both pieces are mounted by the HOST SHELL, not by `ChatPage`: the list is the
 * chat's navigation (it sits in the shell sidebar, where Studio's nav sits) and
 * the settings button sits in the shell header's actions. They read the same two
 * contexts `ChatPage` publishes, so the host renders both below its own
 * `ChatTransportProvider` / `SelectConversationProvider`, and they share the
 * thread's React Query key, so one request feeds all of it. Renaming happens in
 * the settings dialog only: the header's trail shows the name, it does not edit it.
 *
 * The list renders into the host's sidebar (a `SidebarProvider` must be above
 * it): it IS the chat's navigation, so it uses the same rows, groups and active
 * fill as Studio's, or the two products would not read as one app.
 */

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  EllipsisIcon,
  MessagesSquareIcon,
  PlusIcon,
  SearchIcon,
  Settings2Icon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { cn } from "@appstrate/ui/cn";
import { useNowTick } from "@appstrate/ui/use-now-tick";
import { Spinner } from "@appstrate/ui/components/spinner";
import { Button } from "@appstrate/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@appstrate/ui/components/dropdown-menu";
import { Input } from "@appstrate/ui/components/input";
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
import { ConversationRowSkeleton } from "./conversation-skeleton.tsx";
import { groupSessionsByDate, type SessionGroupKey } from "./session-groups.ts";
import { NOTE_TEXT_CLASS, READING_TEXT_DENSE_CLASS, SEARCH_INPUT_CLASS } from "./phone-text.ts";
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
 * `t`, `can` and `formatAge` arrive as props, not from `useChatHost()`: the
 * shell mounts this list outside `ChatPage`, where the host bag is published.
 */
export function ChatConversationList({
  activeId,
  t,
  can,
  renderSpaces,
  formatAge,
}: {
  activeId: string | null;
  t: ChatTranslate;
  can: ChatCan;
  /** Names spaces: every row shows the spaces its conversation touched. */
  renderSpaces: RenderSpaces;
  /**
   * How old an ISO date is as of `now`, as a bare quantity in the host's
   * language (« 5 min », « 3 j »): a row's age column is 56px.
   */
  formatAge: (iso: string, now: number) => string;
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
  // Starting a conversation is a write, as are rename and delete; a reader also gets its own empty copy.
  const canWrite = can("chat:write");
  const hasAny = (base.data?.length ?? 0) > 0;
  const showSearch = hasAny || input !== "";

  const row = (s: SessionSummary) => (
    <ConversationRow
      key={s.id}
      session={s}
      active={s.id === activeId}
      unread={s.unread && s.id !== activeId}
      age={formatAge(s.updatedAt, now)}
      t={t}
      canWrite={canWrite}
      renderSpaces={renderSpaces}
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
              className={SEARCH_INPUT_CLASS}
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
          <SidebarGroupLabel className={NOTE_TEXT_CLASS}>
            {t(searching ? "threads.results" : "threads.title")}
          </SidebarGroupLabel>
        )}
        {/* Grows only with rows to scroll: an empty list must not push its
            empty state to the bottom of the sidebar. The negative margins
            stretch the scroll box over the group's padding to the sidebar's
            edges, as Studio's nav scrolls; `w-auto` lets `-mr-2` widen it. */}
        <SidebarMenu
          className={
            list.length > 0 || isLoading
              ? "-mr-2 -mb-2 min-h-0 w-auto flex-1 overflow-y-auto pr-2 pb-2"
              : undefined
          }
        >
          {isLoading &&
            Array.from({ length: 5 }, (_, i) => (
              <SidebarMenuItem key={i}>
                <ConversationRowSkeleton />
              </SidebarMenuItem>
            ))}
          {searching
            ? list.map(row)
            : groups.map((group) => (
                <li key={group.key} className="flex flex-col gap-1">
                  <SidebarGroupLabel className="mt-1 h-6 px-2 text-sm md:text-[11px]">
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

/** The spaces a conversation touched, named by the host; « Tous les espaces » when it touched none. */
function sessionSpaces(session: SessionSummary, renderSpaces: RenderSpaces, t: ChatTranslate) {
  return session.space_ids.length > 0
    ? renderSpaces(session.space_ids)
    : t("common:overview.title");
}

function ConversationRow({
  session,
  active,
  unread,
  age,
  t,
  canWrite,
  renderSpaces,
}: {
  session: SessionSummary;
  active: boolean;
  unread: boolean;
  /** How old the conversation is, already rendered (« 5 min »). */
  age: string;
  t: ChatTranslate;
  canWrite: boolean;
  renderSpaces: RenderSpaces;
}) {
  const transport = useChatTransport();
  const select = useSelectConversation();
  const queryClient = useQueryClient();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const dialogTrigger = useRef<HTMLButtonElement | null>(null);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const menuAction = useRef<"settings" | "delete" | null>(null);
  const restoreDialogFocus = (event: Event) => {
    if (dialogTrigger.current?.isConnected) {
      event.preventDefault();
      dialogTrigger.current.focus();
    }
  };
  const [deleting, setDeleting] = useState(false);
  const [deleteFailed, setDeleteFailed] = useState(false);

  // The dialog stays open while the delete is in flight and on failure (it says
  // so); it closes only once the row is gone.
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
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={active}
        onClick={() => select?.(session.id)}
        size="lg"
        // Room for the fixed-width right slot below, which is absolutely
        // positioned and would otherwise sit on top of a long title. The host's stacked space tiles
        // ring themselves in `--tile-ring`: the row's background in each of its states.
        className={cn(
          canWrite ? "desktop-pointer:pr-16 pr-[4.5rem]" : "desktop-pointer:pr-16 pr-8",
          "[--tile-ring:var(--sidebar)] hover:[--tile-ring:var(--sidebar-accent)] active:[--tile-ring:var(--sidebar-accent)] data-[active=true]:[--tile-ring:var(--sidebar-accent)]",
        )}
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span
            className={cn(
              "block truncate text-left leading-4 max-md:text-base max-md:leading-5",
              unread && "font-semibold",
            )}
          >
            {session.title ?? t("threads.new")}
          </span>
          <span
            data-testid="chat-session-spaces"
            className={`text-sidebar-foreground/70 flex h-4 min-w-0 items-center max-md:h-5 ${NOTE_TEXT_CLASS}`}
          >
            {sessionSpaces(session, renderSpaces, t)}
          </span>
        </span>
      </SidebarMenuButton>
      {/* Fixed-width right slot: spinner / unread dot / timestamp have different
          natural widths — without w-14 the title's truncation point reflows on
          every generating↔idle transition. Hover swaps them for the row's
          actions; a reader has none, so for them hover changes nothing. */}
      <div
        className={cn(
          "desktop-pointer:w-14 pointer-events-none absolute top-1 right-1 flex h-6 w-6 items-center justify-end rounded-md",
          canWrite &&
            "desktop-pointer:right-1 desktop-pointer:group-hover/menu-item:bg-sidebar-accent desktop-pointer:group-focus-within/menu-item:bg-sidebar-accent right-11",
        )}
      >
        {session.generating ? (
          <Spinner
            className="text-sidebar-foreground/70 size-3.5"
            aria-label={t("threads.generating")}
          />
        ) : unread ? (
          <span
            className={`bg-primary size-2 rounded-full transition-opacity ${canWrite ? "desktop-pointer:group-hover/menu-item:opacity-0 desktop-pointer:group-focus-within/menu-item:opacity-0" : ""}`}
            aria-label={t("threads.unread")}
            title={t("threads.unread")}
          />
        ) : (
          <span
            className={`text-sidebar-foreground/70 desktop-pointer:inline hidden text-xs transition-opacity ${canWrite ? "desktop-pointer:group-hover/menu-item:opacity-0 desktop-pointer:group-focus-within/menu-item:opacity-0" : ""}`}
          >
            {age}
          </span>
        )}
        {/* pointer-events must track visibility: opacity-0 alone keeps the
            invisible buttons tappable. Touchscreens use the separate 44 px menu trigger. */}
        {canWrite && (
          <div className="desktop-pointer:flex pointer-events-none absolute right-0 hidden items-center gap-0.5 rounded-md p-0.5 opacity-0 transition-opacity group-focus-within/menu-item:pointer-events-auto group-focus-within/menu-item:opacity-100 group-hover/menu-item:pointer-events-auto group-hover/menu-item:opacity-100">
            <button
              type="button"
              aria-label={t("threads.settings.openFor", {
                title: session.title ?? t("threads.new"),
              })}
              title={t("threads.settings.title")}
              onClick={(event) => {
                dialogTrigger.current = event.currentTarget;
                setSettingsOpen(true);
              }}
              className="text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-border rounded-md p-0.5"
            >
              <Settings2Icon className="size-3.5" />
            </button>
            <button
              type="button"
              aria-label={t("common:btn.delete")}
              title={t("common:btn.delete")}
              onClick={(event) => {
                dialogTrigger.current = event.currentTarget;
                setDeleteFailed(false);
                setConfirmingDelete(true);
              }}
              className="text-sidebar-foreground/70 hover:text-destructive hover:bg-destructive/10 rounded-md p-0.5"
            >
              <Trash2Icon className="size-3.5" />
            </button>
          </div>
        )}
      </div>
      {canWrite && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t("threads.actions.openFor", {
                title: session.title ?? t("threads.new"),
              })}
              ref={menuTrigger}
              className="text-sidebar-foreground/70 active:bg-sidebar-accent desktop-pointer:hidden absolute top-0 right-0 flex h-12 w-11 items-center justify-center rounded-md"
            >
              <EllipsisIcon className="size-5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="min-w-48"
            onCloseAutoFocus={(event) => {
              const action = menuAction.current;
              if (!action) return;
              event.preventDefault();
              menuAction.current = null;
              dialogTrigger.current = menuTrigger.current;
              if (action === "settings") setSettingsOpen(true);
              else {
                setDeleteFailed(false);
                setConfirmingDelete(true);
              }
            }}
          >
            <DropdownMenuItem
              className="min-h-11"
              onSelect={() => {
                menuAction.current = "settings";
              }}
            >
              <Settings2Icon />
              {t("threads.settings.title")}
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-destructive focus:text-destructive min-h-11"
              onSelect={() => {
                menuAction.current = "delete";
              }}
            >
              <Trash2Icon />
              {t("common:btn.delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <AlertDialog
        open={confirmingDelete}
        onOpenChange={(open) => !deleting && setConfirmingDelete(open)}
      >
        <AlertDialogContent data-testid="chat-delete-confirm" onCloseAutoFocus={restoreDialogFocus}>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("threads.delete.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("threads.delete.description", { title: session.title ?? t("threads.new") })}
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
      {settingsOpen && (
        <ConversationSettingsDialog
          session={session}
          t={t}
          onCloseAutoFocus={restoreDialogFocus}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </SidebarMenuItem>
  );
}

/**
 * The open conversation's settings button, for the host's header actions. Renders
 * nothing until the conversation is known, or for a reader (settings are writes).
 */
export function ChatConversationSettingsButton(props: {
  activeId: string | null;
  t: ChatTranslate;
  can: ChatCan;
}) {
  return <ConversationSettingsButton key={props.activeId} {...props} />;
}

function ConversationSettingsButton({
  activeId,
  t,
  can,
}: {
  activeId: string | null;
  t: ChatTranslate;
  can: ChatCan;
}) {
  const [open, setOpen] = useState(false);
  const { data: sessions } = useSessions();
  const session = activeId ? sessions?.find((s) => s.id === activeId) : undefined;
  if (!session || !can("chat:write")) return null;
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-8"
        aria-label={t("threads.settings.title")}
        title={t("threads.settings.title")}
        onClick={() => setOpen(true)}
      >
        <Settings2Icon className="size-4" />
      </Button>
      {open && (
        <ConversationSettingsDialog session={session} t={t} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

/**
 * The conversation's settings: its name, saved explicitly (Enregistrer or Enter),
 * never on blur. The dialog stays open on a refusal and says so: the chat's own
 * fetch is not toasted by the app's mutation cache.
 */
function ConversationSettingsDialog({
  session,
  t,
  onClose,
  onCloseAutoFocus,
}: {
  session: SessionSummary;
  t: ChatTranslate;
  onClose: () => void;
  onCloseAutoFocus?: (event: Event) => void;
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
      <DialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>{t("threads.settings.title")}</DialogTitle>
          <DialogDescription>{t("threads.settings.description")}</DialogDescription>
        </DialogHeader>
        <form
          id="chat-conversation-settings"
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <Label htmlFor="chat-conversation-name">{t("threads.settings.name")}</Label>
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
          <Button type="submit" form="chat-conversation-settings" disabled={saving || !dirty}>
            {saving && <Spinner className="mr-1.5 size-3.5" />}
            {t("common:btn.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
