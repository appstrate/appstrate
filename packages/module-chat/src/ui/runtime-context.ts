// SPDX-License-Identifier: Apache-2.0

/**
 * The host→module injection seam. Everything the chat UI needs from the shell —
 * scoping headers, navigation, file services, translation — arrives through
 * `ChatPage`'s props and is published from there.
 *
 * This is the ONLY direction the dependency runs: the module never imports the
 * web shell (nor the shell's API client, router, or i18n), and the shell never
 * imports module internals. A service the shell already owns (authenticated
 * download, authenticated image preview, staged upload) is injected rather than
 * reimplemented here — one implementation, one set of error semantics.
 *
 * THREE contexts, no more:
 *  - `ChatTransport` — `getHeaders` (the scoping headers: the card-local SSE stream
 *    to `/api/realtime` needs the caller's `X-Org-Id` / `X-Space-Id`, which only the
 *    host knows), `request`, the ONE function every REST call of the chat goes
 *    through, and the organization and space filter the chat's routes are read through.
 *  - `selectConversation` — navigation, see below.
 *  - `ChatHost` — ONE bag of host services, memoized by `ChatPage` from its
 *    props. Deliberately not one context per service: every member is
 *    `useCallback`-stable in the host that mounts this UI, so a single memoized
 *    object is exactly as re-render-stable as N contexts would be, and it needs
 *    ONE missing-provider guard instead of N hand-tuned defaults that the single
 *    call site (all props required) can never reach anyway.
 *
 * `uploadFile` is NOT in the bag: its only consumer is the composer's attachment
 * adapter, which the conversation builds from the prop `ChatPage` passes down — a
 * context hop for a value that never leaves the file would be pure ceremony.
 */

import { createContext, useContext, type ComponentType, type ReactNode } from "react";
import type { PickerCredential } from "@appstrate/ui/components/model-picker-groups";

export type GetHeaders = () => Record<string, string>;

/**
 * The host's `fetch` for the platform API: same-origin, credentialed, scoping headers added,
 * and a non-2xx answer THROWN as the host's own error (RFC 9457 problem details: `status`,
 * `code`, the server's `detail`), so the shell's global error handling renders a failure in the
 * user's language instead of a bare "HTTP 500". Streaming bodies stay readable on the response.
 */
export type ChatRequest = (path: string, init?: RequestInit) => Promise<Response>;

/**
 * What the chat page reads. A conversation belongs to the organization and its author, so every
 * chat call goes to `/api/orgs/{orgId}/chat/*`; `spaceId` is the conversation list's filter
 * (`?spaceId=`): the space the host is looking at, `null` in « Tous les espaces », where the list
 * holds every conversation. It is also the origin of a new conversation, when the chat acts there.
 */
export interface ChatTransport {
  getHeaders: GetHeaders;
  request: ChatRequest;
  orgId: string;
  spaceId: string | null;
}

/**
 * The host's rendering of spaces by id (its tile and name, every space shown). The module
 * names the spaces a conversation touched, and the space of a tool call, through it.
 */
export type RenderSpaces = (spaceIds: readonly string[]) => ReactNode;

/**
 * The host's space picker, opened from a button or from an entry in a menu.
 */
export type SpaceChoiceMenu = ComponentType<{
  variant: "dropdown" | "submenu";
  label: string;
  spaceIds: readonly string[];
  onPick: (spaceId: string) => void;
  trigger: ReactNode;
  testId?: string;
}>;

const ChatTransportContext = createContext<ChatTransport | null>(null);

export const ChatTransportProvider = ChatTransportContext.Provider;

export function useChatTransport(): ChatTransport | null {
  return useContext(ChatTransportContext);
}

/** The HTTP status a thrown request error carries (`ApiError.status`), when it carries one. */
export function errorStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
}

/** A JSON write: the body serialized, the content type set. */
export function jsonInit(method: string, body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

/**
 * Selecting a conversation = changing the host URL (the single source of truth).
 * The list (`thread-list.tsx`) calls this on click; the host navigates and the
 * keyed `<Conversation>` remounts on the new id. `null` means "new conversation"
 * (`/chat`). Carried through context so module-chat never imports a router.
 *
 * A conversation opens in place, whatever the list's filter.
 */
export type SelectConversation = (id: string | null) => void;

const SelectConversationContext = createContext<SelectConversation | null>(null);

export const SelectConversationProvider = SelectConversationContext.Provider;

export function useSelectConversation(): SelectConversation | null {
  return useContext(SelectConversationContext);
}

/**
 * Presents a file through the host's in-app viewer. The same small interface
 * serves direct clicks and the automatic presentation of a run's single produced
 * file. The host does not need to know why it was called: both interactions
 * select the file in the same conversation context panel.
 *
 * The module owns no preview component — dependency direction is web →
 * module-chat, so the host injects an opener and the chat delegates to it.
 * `null` means no opener was provided (embedded mounts): direct clicks then fall
 * back to the authenticated download, while automatic presentation is a no-op.
 *
 * `spaceId` names the file's space when known (the space of the call of the conversation that
 * produced it): the host reads it there, and reads in the working space when it is the same one.
 * The download and the image hook below take it the same way.
 */
export type OpenFile = (file: { id: string; name: string; spaceId?: string }) => void;

/**
 * The host's authenticated file download (typed API client + user-facing
 * error toast). Injected, never reimplemented: a second raw-`fetch` copy here
 * would swallow failures the shell's implementation reports.
 */
export type DownloadFile = (id: string, name: string, spaceId?: string) => void;

/**
 * The host's authenticated image-preview hook: a stored file id → an object
 * URL for an `<img src>`, `undefined` while loading, `null` when there is none (callers fall
 * back to the chip). A HOOK is injected — not a fetcher — so the shell keeps
 * ownership of the request, its scoping headers and the object-URL lifecycle.
 *
 * Call it like any hook: unconditionally, at the top of a component (see
 * `FileImageThumbnail`, which exists precisely so the call site is stable).
 */
export type UseFileImageSrc = (id: string, spaceId?: string) => string | null | undefined;

/**
 * The host's staged upload (`POST /api/uploads` descriptor + PUT to the sink) into `spaceId`,
 * returning the `upload://upl_x` URI the server materializes into a durable file there. The
 * module adds only its staged-image preview cache on top (`upload.ts`). Travels as a `ChatPage`
 * prop, not through context (see the file header).
 */
export type UploadFile = (file: File, spaceId: string, signal?: AbortSignal) => Promise<string>;

/**
 * The host's i18next `t`, scoped to the chat namespace. The seam exists so the
 * module never imports the shell's i18n framework: the shell resolves the key
 * and the chat renders whatever comes back, in the same language as the answers
 * (`X-Chat-Locale`). Keys are FLAT dotted strings, matching the locale JSONs
 * verbatim, and may carry an explicit `<namespace>:` prefix — the host `t`
 * must resolve those against its loaded boot namespaces (`model-select.tsx`
 * passes `settings:models.generation.*`, shared with the web settings page).
 *
 * The migration is INCOMPLETE: roughly two dozen literal French strings remain
 * in `index.tsx`, `thread.tsx`, `thread-list.tsx`, `oauth-connect-card.tsx` and
 * `tool-uis.tsx`. New user-facing text goes through `t`; the leftovers are a
 * known debt, not a design.
 */
export type ChatTranslate = (key: string, params?: Record<string, string | number>) => string;

/**
 * The host services the chat UI consumes but does not implement. One object,
 * one provider, one guard — see the file header for why this is not split.
 */
export interface ChatHost {
  /** `null` when the host provides no in-app preview (fall back to download). */
  openFile: OpenFile | null;
  downloadFile: DownloadFile;
  useFileImageSrc: UseFileImageSrc;
  t: ChatTranslate;
  can: ChatCan;
  /**
   * The caller's grant in one NAMED space, for what a call of a conversation did there (its run,
   * its files): `can` answers for the chat as a whole.
   */
  canIn: ChatCanIn;
  /**
   * The spaces the chat acts in (the host's acting set), `null` until the host's listing has
   * answered: what needs it then waits, and gives no reason. The skills picker lists them, and a
   * new conversation takes the selected space (`ChatTransport.spaceId`) as its origin only when it
   * is one of them.
   */
  actingSpaceIds: readonly string[] | null;
  /**
   * Whether the organization lets members bring personal model credentials. The
   * shell reads it from the org settings; when off, a refusal that a personal
   * credential would fix names no link to add one. `undefined` until the
   * settings load: such a refusal then names neither the link nor the policy.
   */
  personalModelCredentials: boolean | undefined;
  /**
   * The credentials that name the model picker's groups: the organization's (when the caller
   * may read them) and the caller's own, with the upstream models each serves. The shell
   * builds them from its provider registry; empty until they load.
   */
  modelCredentials: readonly PickerCredential[];
  /** A byte count in the language the host renders (`2,0 Ko` in French). */
  formatBytes: (bytes: number) => string;
  /**
   * The assistant created or imported a package: the host refreshes what lists
   * packages, as its own editor and import dialog do after a write.
   */
  onPackagesChanged: () => void;
  /** The signed-in user's first name, greeted on a new conversation; the host derives it as its dashboard does. */
  firstName?: string | null;
  /** Names spaces. */
  renderSpaces: RenderSpaces;
  /**
   * Where an in-app `path` opens for a row of `spaceId`: the host names the space in the link when
   * it is not the working one (its `?enterSpace=` convention), else returns `path` unchanged.
   */
  linkInSpace: (path: string, spaceId: string | undefined) => string;
  /**
   * A hook returning a space's plain name by id (`undefined` for one the caller does not reach),
   * for the accessible names that carry a space's name where `renderSpaces`' node would not.
   */
  useSpaceLabelOf: () => (spaceId: string | null | undefined) => string | undefined;
  /** The host's menu of spaces, the one every « … in which space? » entry of the app opens. */
  SpaceChoiceMenu: SpaceChoiceMenu;
}

/** Whether the chat acts in `spaceId` (one of the host's acting set). */
export function actsIn(
  actingSpaceIds: readonly string[] | null,
  spaceId: string | null | undefined,
): boolean {
  return !!spaceId && !!actingSpaceIds?.includes(spaceId);
}

/**
 * The caller's grants, resolved by the shell. The chat asks for the exact
 * permission each endpoint it calls guards on and holds no RBAC of its own. The shell answers
 * "some space where the chat may act grants it".
 */
export type ChatCan = (permission: string) => boolean;

/** {@link ChatCan} in one named space. */
export type ChatCanIn = (spaceId: string, permission: string) => boolean;

const ChatHostContext = createContext<ChatHost | null>(null);

export const ChatHostProvider = ChatHostContext.Provider;

/**
 * The injected host services. Throws when rendered outside `<ChatPage>`: every
 * member is a REQUIRED prop there, so an absent provider is a wiring bug, and
 * failing loudly beats a silent no-op download or an echoed translation key.
 */
export function useChatHost(): ChatHost {
  const host = useContext(ChatHostContext);
  if (!host) {
    throw new Error("module-chat: no host services injected (render inside <ChatPage>)");
  }
  return host;
}

/**
 * The grant a card judges where its call acted: in `spaceId` when the call named one, else the
 * chat's own. Judging a run or a file read in the working space would refuse what the call's
 * space grants, and grant what it refuses.
 */
export function useCanIn(): (spaceId: string | undefined, permission: string) => boolean {
  const { can, canIn } = useChatHost();
  return (spaceId, permission) => (spaceId ? canIn(spaceId, permission) : can(permission));
}
