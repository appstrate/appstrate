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

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { PlusIcon, Settings2Icon, Trash2Icon } from "lucide-react";
import { relativeAge } from "@appstrate/core/format";
import { Spinner } from "@appstrate/ui/components/spinner";
import { Button } from "@appstrate/ui/components/button";
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
  SidebarMenu,
  SidebarMenuSkeleton,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@appstrate/ui/components/sidebar";
import {
  useChatTransport,
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
import { useSessions } from "./use-sessions.ts";

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
  const {
    data: sessions,
    isLoading,
    isError,
    refetch,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = useSessions();
  const now = useNowTick();
  const list = sessions ?? [];
  // Rename and delete are writes; a reader also gets its own empty copy.
  const canWrite = can("chat:write");
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
        <SidebarGroupLabel>{t("threads.title")}</SidebarGroupLabel>
        <SidebarMenu className="min-h-0 flex-1 overflow-y-auto">
          {isLoading &&
            Array.from({ length: 5 }, (_, i) => (
              <SidebarMenuItem key={i}>
                <SidebarMenuSkeleton />
              </SidebarMenuItem>
            ))}
          {list.map((s) => (
            <ConversationRow
              key={s.id}
              session={s}
              active={s.id === activeId}
              unread={s.unread && s.id !== activeId}
              now={now}
              t={t}
              canWrite={canWrite}
            />
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
        {!isLoading && !isError && list.length === 0 && (
          <p className="text-sidebar-foreground/70 px-2 py-6 text-center text-xs">
            {t(canWrite ? "threads.empty" : "threads.emptyReadOnly")}
          </p>
        )}
      </SidebarGroup>
    </>
  );
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
  const transport = useChatTransport();
  const select = useSelectConversation();
  const queryClient = useQueryClient();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteFailed, setDeleteFailed] = useState(false);

  // The dialog stays open while the delete is in flight and on failure (it says
  // so); it closes only once the row is gone.
  const onDelete = async () => {
    if (!transport) return;
    setDeleting(true);
    setDeleteFailed(false);
    try {
      await deleteSession(transport.request, session.id);
    } catch {
      // Not a `useMutation`, so the app's mutation cache does not toast it: say it in the dialog.
      setDeleteFailed(true);
      setDeleting(false);
      return;
    }
    setConfirmingDelete(false);
    setDeleting(false);
    // Reflect the delete in the cached list. Cancel any in-flight poll first so
    // its stale (pre-delete) response can't land afterwards and resurrect the
    // row; then drop the row. The server is already updated and the periodic
    // poll reconciles any later drift.
    await queryClient.cancelQueries({ queryKey: SESSIONS_QUERY_KEY });
    queryClient.setQueryData<SessionsCache>(
      sessionsQueryKey(spaceIdFromHeaders(transport.getHeaders)),
      (prev) => patchSessionsCache(prev, (rows) => rows.filter((s) => s.id !== session.id)),
    );
    if (active) select?.(null);
  };

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
              aria-label={t("threads.settings.openFor", {
                title: session.title ?? t("threads.new"),
              })}
              title={t("threads.settings.title")}
              onClick={() => setSettingsOpen(true)}
              className="text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-border rounded-md p-0.5"
            >
              <Settings2Icon className="size-3.5" />
            </button>
            <button
              type="button"
              aria-label={t("common:btn.delete")}
              title={t("common:btn.delete")}
              onClick={() => {
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
      <AlertDialog
        open={confirmingDelete}
        onOpenChange={(open) => !deleting && setConfirmingDelete(open)}
      >
        <AlertDialogContent data-testid="chat-delete-confirm">
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
}: {
  session: SessionSummary;
  t: ChatTranslate;
  onClose: () => void;
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
      await renameSession(transport.request, session.id, next);
      await queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
      onClose();
    } catch {
      setFailed(true);
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent>
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
