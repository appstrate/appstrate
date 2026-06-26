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
