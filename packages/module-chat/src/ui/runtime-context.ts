// SPDX-License-Identifier: Apache-2.0

/**
 * The host→module injection seam. Everything the chat UI needs from the shell —
 * scoping headers, navigation, document services, translation — arrives through
 * these contexts, set once by `ChatPage` from its props.
 *
 * This is the ONLY direction the dependency runs: the module never imports the
 * web shell (nor the shell's API client, router, or i18n), and the shell never
 * imports module internals. A service the shell already owns (authenticated
 * download, staged upload, authenticated image preview) is injected rather than
 * reimplemented here — one implementation, one set of error semantics.
 *
 * The `getHeaders` seam predates the rest: the OAuth connect card
 * (`oauth-connect-card.tsx`) opens a card-local SSE stream to `/api/realtime`,
 * and building that URL needs the caller's `X-Org-Id` / `X-Application-Id`,
 * which only the host knows.
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

/**
 * Opens the host's in-app document preview (the same modal the documents library
 * uses). The module owns no preview component — dependency direction is web →
 * module-chat, so the host injects an opener and the chat delegates to it.
 * `null` means no opener was provided (embedded mounts): callers must then fall
 * back to the authenticated download.
 */
export type OpenDocument = (doc: { id: string; name: string }) => void;

const OpenDocumentContext = createContext<OpenDocument | null>(null);

export const OpenDocumentProvider = OpenDocumentContext.Provider;

export function useOpenDocument(): OpenDocument | null {
  return useContext(OpenDocumentContext);
}

/**
 * The host's authenticated document download (typed API client + user-facing
 * error toast). Injected, never reimplemented: a second raw-`fetch` copy here
 * would swallow failures the shell's implementation reports.
 *
 * `ChatPage` requires the prop, so the provider always holds the real one; the
 * default exists only so a component rendered outside the provider fails loudly
 * instead of silently doing nothing.
 */
export type DownloadDocument = (id: string, name: string) => void;

const DownloadDocumentContext = createContext<DownloadDocument>(() => {
  throw new Error("module-chat: no downloadDocument injected (render inside <ChatPage>)");
});

export const DownloadDocumentProvider = DownloadDocumentContext.Provider;

export function useDownloadDocument(): DownloadDocument {
  return useContext(DownloadDocumentContext);
}

/**
 * The host's authenticated image-preview hook: a stored document id → an object
 * URL for an `<img src>`, or `null` while loading / on failure (callers fall
 * back to the chip). A HOOK is injected — not a fetcher — so the shell keeps
 * ownership of the request, its scoping headers and the object-URL lifecycle.
 *
 * Call it like any hook (unconditionally, at the top of a component); the
 * default returns `null`, i.e. "no thumbnails", which is a valid rendering.
 */
export type UseDocumentImageSrc = (id: string) => string | null;

const DocumentImageSrcContext = createContext<UseDocumentImageSrc>(() => null);

export const DocumentImageSrcProvider = DocumentImageSrcContext.Provider;

/** Returns the injected hook — call the result as a hook (`useImageSrc(id)`). */
export function useDocumentImageSrcHook(): UseDocumentImageSrc {
  return useContext(DocumentImageSrcContext);
}

/**
 * The host's staged upload (`POST /api/uploads` descriptor + PUT to the sink),
 * returning the `upload://upl_x` URI the server materializes into a durable
 * document. Same function the shell hands to its own `<SchemaForm>` uploader —
 * the module adds only its staged-image preview cache on top (`upload.ts`).
 */
export type UploadFile = (file: File, signal?: AbortSignal) => Promise<string>;

const UploadFileContext = createContext<UploadFile>(() => {
  throw new Error("module-chat: no uploadFile injected (render inside <ChatPage>)");
});

export const UploadFileProvider = UploadFileContext.Provider;

export function useUploadFile(): UploadFile {
  return useContext(UploadFileContext);
}

/**
 * The host's per-upload size cap in bytes — the same number the platform
 * enforces, owned by the shell so the module never hardcodes a server limit.
 * Guarding client-side is a UX fast-path only (the server still 413s).
 */
const MaxUploadBytesContext = createContext<number>(Number.POSITIVE_INFINITY);

export const MaxUploadBytesProvider = MaxUploadBytesContext.Provider;

export function useMaxUploadBytes(): number {
  return useContext(MaxUploadBytesContext);
}

/**
 * The host's i18next `t`, scoped to the chat namespace. The chat UI ships no
 * literal user-facing text: every string (including `aria-label`s) resolves
 * through here, so the shell's language — the same one `X-Chat-Locale` sends to
 * the assistant — is what the user reads.
 *
 * Keys are FLAT dotted strings, matching the locale JSONs verbatim. The default
 * echoes the key: a component rendered outside the provider is visibly broken
 * rather than silently French.
 */
export type ChatTranslate = (key: string, params?: Record<string, string | number>) => string;

const ChatTranslateContext = createContext<ChatTranslate>((key) => key);

export const ChatTranslateProvider = ChatTranslateContext.Provider;

export function useChatTranslate(): ChatTranslate {
  return useContext(ChatTranslateContext);
}
