// SPDX-License-Identifier: Apache-2.0

/**
 * The host→module injection seam. Everything the chat UI needs from the shell —
 * scoping headers, navigation, document services, translation — arrives through
 * `ChatPage`'s props and is published from there.
 *
 * This is the ONLY direction the dependency runs: the module never imports the
 * web shell (nor the shell's API client, router, or i18n), and the shell never
 * imports module internals. A service the shell already owns (authenticated
 * download, authenticated image preview, staged upload) is injected rather than
 * reimplemented here — one implementation, one set of error semantics.
 *
 * THREE contexts, no more:
 *  - `getHeaders` — the OAuth connect card (`oauth-connect-card.tsx`) opens a
 *    card-local SSE stream to `/api/realtime`, and building that URL needs the
 *    caller's `X-Org-Id` / `X-Application-Id`, which only the host knows.
 *  - `selectConversation` — navigation, see below.
 *  - `ChatHost` — ONE bag of host services, memoized by `ChatPage` from its
 *    props. Deliberately not one context per service: every member is
 *    `useCallback`-stable in the host that mounts this UI, so a single memoized
 *    object is exactly as re-render-stable as N contexts would be, and it needs
 *    ONE missing-provider guard instead of N hand-tuned defaults that the single
 *    call site (all props required) can never reach anyway.
 *
 * `uploadFile` is NOT in the bag: its only consumer is the composer's attachment
 * adapter, which `ChatPage` builds itself and passes down as a prop — a context
 * hop for a value that never leaves the file would be pure ceremony.
 */

import { createContext, useContext } from "react";

export type GetHeaders = () => Record<string, string>;

const ChatHeadersContext = createContext<GetHeaders | null>(null);

export const ChatHeadersProvider = ChatHeadersContext.Provider;

export function useChatHeaders(): GetHeaders | null {
  return useContext(ChatHeadersContext);
}

/**
 * Selecting a conversation = changing the host URL (the single source of truth).
 * The list (`thread-list.tsx`) calls this on click; the host navigates and the
 * keyed `<Conversation>` remounts on the new id. `null` means "new conversation"
 * (`/chat`). Carried through context so module-chat never imports a router.
 */
export type SelectConversation = (id: string | null) => void;

const SelectConversationContext = createContext<SelectConversation | null>(null);

export const SelectConversationProvider = SelectConversationContext.Provider;

export function useSelectConversation(): SelectConversation | null {
  return useContext(SelectConversationContext);
}

/** Why the chat is asking its host to present a document. */
export interface DocumentOpenOptions {
  /** A direct click always wins over a later automatic primary presentation. */
  trigger: "manual" | "primary";
}

/**
 * Presents a document through the host's in-app viewer. The same small interface
 * serves direct clicks and automatic primary-output presentation; `trigger` lets
 * the host keep user intent authoritative without leaking its panel state back
 * into module-chat.
 *
 * The module owns no preview component — dependency direction is web →
 * module-chat, so the host injects an opener and the chat delegates to it.
 * `null` means no opener was provided (embedded mounts): direct clicks then fall
 * back to the authenticated download, while automatic presentation is a no-op.
 */
export type OpenDocument = (
  doc: { id: string; name: string },
  options: DocumentOpenOptions,
) => void;

/**
 * The host's authenticated document download (typed API client + user-facing
 * error toast). Injected, never reimplemented: a second raw-`fetch` copy here
 * would swallow failures the shell's implementation reports.
 */
export type DownloadDocument = (id: string, name: string) => void;

/**
 * The host's authenticated image-preview hook: a stored document id → an object
 * URL for an `<img src>`, or `null` while loading / on failure (callers fall
 * back to the chip). A HOOK is injected — not a fetcher — so the shell keeps
 * ownership of the request, its scoping headers and the object-URL lifecycle.
 *
 * Call it like any hook: unconditionally, at the top of a component (see
 * `DocumentImageThumbnail`, which exists precisely so the call site is stable).
 */
export type UseDocumentImageSrc = (id: string) => string | null;

/**
 * The host's staged upload (`POST /api/uploads` descriptor + PUT to the sink),
 * returning the `upload://upl_x` URI the server materializes into a durable
 * document. Same function the shell hands to its own `<SchemaForm>` uploader —
 * the module adds only its staged-image preview cache on top (`upload.ts`).
 * Travels as a `ChatPage` prop, not through context (see the file header).
 */
export type UploadFile = (file: File, signal?: AbortSignal) => Promise<string>;

/**
 * The host's i18next `t`, scoped to the chat namespace. The seam exists so the
 * module never imports the shell's i18n framework: the shell resolves the key
 * and the chat renders whatever comes back, in the same language as the answers
 * (`X-Chat-Locale`). Keys are FLAT dotted strings, matching the locale JSONs
 * verbatim.
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
  openDocument: OpenDocument | null;
  downloadDocument: DownloadDocument;
  useDocumentImageSrc: UseDocumentImageSrc;
  t: ChatTranslate;
}

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
