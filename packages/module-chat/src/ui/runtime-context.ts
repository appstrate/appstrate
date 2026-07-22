// SPDX-License-Identifier: Apache-2.0

/**
 * Bridges the host shell's `getHeaders` (org/app/auth) down to deep tool UIs.
 *
 * The OAuth connect card (`oauth-connect-card.tsx`) opens a card-local SSE
 * stream to `/api/realtime` as a cross-tab/device backstop for connection
 * completion; building that URL needs the caller's `X-Org-Id` /
 * `X-Application-Id`, which only the host (`ChatPage`) knows. Passing it through
 * context avoids threading props through assistant-ui's render tree.
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
