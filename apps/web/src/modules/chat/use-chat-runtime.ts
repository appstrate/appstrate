// SPDX-License-Identifier: Apache-2.0

/**
 * What the chat module is handed by the host, computed the same way for both
 * places that mount its UI: the conversation list in the shell's sidebar and
 * the thread in the page. Kept free of `@appstrate/module-chat/ui` so the
 * shell can call it without pulling the chat's UI into the entry chunk.
 */

import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { buildScopingHeaders } from "../../lib/scoping-headers";
import { useViewAsHeader } from "../../stores/view-as-store";
import { useCurrentSpaceId } from "../../hooks/use-current-space";

/**
 * Scoping headers + the active UI language, so the assistant replies in the
 * language the user actually reads (the server defaults to fr without it).
 * Reads `i18n.language` at call time — the transport invokes this per request,
 * so a language switch applies to the next send.
 *
 * Persona and space are threaded through so this callback's identity moves
 * with either: the module's streams read their URL once, and would otherwise
 * keep tailing under the replaced authority or miss a space resolved late.
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

/** The `chat` namespace's `t`, in the shape the module takes. */
export function useChatTranslate() {
  const { t } = useTranslation("chat");
  return useCallback(
    (key: string, params?: Record<string, string | number>) => t(key, params ?? {}),
    [t],
  );
}
