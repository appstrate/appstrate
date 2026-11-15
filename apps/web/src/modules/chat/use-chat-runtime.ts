// SPDX-License-Identifier: Apache-2.0

/** Host-provided chat inputs, shared by the sidebar list and the page thread. Must not import `@appstrate/module-chat/ui` (entry chunk). */

import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { fetchOrThrow } from "../../api/client";
import { buildScopingHeaders } from "../../lib/scoping-headers";
import { useViewAsHeader } from "../../stores/view-as-store";
import { useCurrentSpaceId } from "../../hooks/use-current-space";

/**
 * Scoping headers + the UI language (server defaults to fr without it), read at
 * call time. Persona and space are deps so the callback's identity moves with
 * them: the module's streams read their URL once and would keep the old authority.
 */
export function useChatGetHeaders() {
  const { i18n } = useTranslation("chat");
  const viewAs = useViewAsHeader();
  const spaceId = useCurrentSpaceId();
  return useCallback(
    () => ({ ...buildScopingHeaders(viewAs, spaceId), "X-Chat-Locale": i18n.language }),
    [i18n, viewAs, spaceId],
  );
}

/**
 * The chat's `ChatTransport` over `getHeaders`: its REST calls go through {@link fetchOrThrow}, so
 * a refusal carries the server's code and reaches the shell's global error handling.
 */
export function chatTransport(getHeaders: () => Record<string, string>) {
  return {
    getHeaders,
    request: (path: string, init?: RequestInit) => {
      const headers = new Headers(getHeaders());
      new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
      return fetchOrThrow(path, { ...init, headers });
    },
  };
}

/** The shell's own transport (nav badge, outside a chat page): scoping headers only, no chat locale. */
export const SHELL_CHAT_TRANSPORT = chatTransport(buildScopingHeaders);

/** {@link chatTransport} over the page's headers; its identity moves with them. */
export function useChatTransport() {
  const getHeaders = useChatGetHeaders();
  return useMemo(() => chatTransport(getHeaders), [getHeaders]);
}

/** The `chat` namespace's `t`, in the shape the module takes. */
export function useChatTranslate() {
  const { t } = useTranslation("chat");
  return useCallback(
    (key: string, params?: Record<string, string | number>) => t(key, params ?? {}),
    [t],
  );
}
