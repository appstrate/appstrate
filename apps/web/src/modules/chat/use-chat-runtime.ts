// SPDX-License-Identifier: Apache-2.0

/** Host-provided chat inputs, shared by the sidebar list and the page thread. Must not import `@appstrate/module-chat/ui` (entry chunk). */

import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { buildScopingHeaders } from "../../lib/scoping-headers";
import { useViewAsHeader } from "../../stores/view-as-store";
import { useCurrentSpaceId } from "../../hooks/use-current-space";
import { useCurrentOrgId, useOrg } from "../../hooks/use-org";
import { useOverviewMode } from "../../hooks/use-overview-mode";
import { useRowSpaceGrants } from "../../hooks/use-space-action";
import { useSpaces } from "../../hooks/use-spaces";
import { actingSpaces, grantedInSomeActingSpace } from "../../lib/space-lists";
import { chatTransport } from "./chat-transport";

/**
 * Scoping headers + the UI language (server defaults to fr without it), read at
 * call time. Persona and space are deps so the callback's identity moves with
 * them: the module's streams read their URL once and would keep the old authority.
 */
function useChatGetHeaders() {
  const { i18n } = useTranslation("chat");
  const viewAs = useViewAsHeader();
  const spaceId = useCurrentSpaceId();
  return useCallback(
    () => ({ ...buildScopingHeaders(viewAs, spaceId), "X-Chat-Locale": i18n.language }),
    [i18n, viewAs, spaceId],
  );
}

/**
 * The space the chat is filtered to: the selected space, none in « Vue d'ensemble » (the chat holds
 * the mode). `known` once the space listing has answered: before, the mode cannot be told, and a
 * chat page would read the wrong list. `ready` once the filter itself is settled: known, and a
 * space resolved when one is selected.
 */
export function useChatFilter(): { spaceId: string | null; known: boolean; ready: boolean } {
  const { on, known } = useOverviewMode();
  const currentSpaceId = useCurrentSpaceId();
  const spaceId = on ? null : currentSpaceId;
  return { spaceId, known, ready: known && (on || spaceId !== null) };
}

/**
 * {@link chatTransport} over `getHeaders`, for the filter in force; its identity moves with it.
 * Undefined until the organization and the filter are settled: the chat's queries wait for it.
 */
function useTransportOver(getHeaders: () => Record<string, string>) {
  const orgId = useCurrentOrgId();
  const { spaceId, ready } = useChatFilter();
  return useMemo(
    () => (orgId && ready ? chatTransport(getHeaders, orgId, spaceId) : undefined),
    [getHeaders, orgId, ready, spaceId],
  );
}

/** The shell's own transport (nav badge, outside a chat page): scoping headers only, no chat locale. */
export function useShellChatTransport() {
  return useTransportOver(buildScopingHeaders);
}

/** {@link chatTransport} over the page's headers (scoping and chat locale). */
export function useChatTransport() {
  return useTransportOver(useChatGetHeaders());
}

/** The `chat` namespace's `t`, in the shape the module takes. */
export function useChatTranslate() {
  const { t } = useTranslation("chat");
  return useCallback(
    (key: string, params?: Record<string, string | number>) => t(key, params ?? {}),
    [t],
  );
}

/**
 * The grants the chat module reads as its own: "some space where the chat may act grants it" (a
 * conversation acts in the spaces the caller names, never in the working one the host merely
 * stands in).
 */
export function useChatCan() {
  const { data: spaces } = useSpaces();
  const orgPermissions = useOrg().currentOrg?.permissions;
  return useCallback(
    (permission: string) => grantedInSomeActingSpace(spaces, orgPermissions, permission),
    [spaces, orgPermissions],
  );
}

/**
 * The ids of the spaces the chat acts in (the backend's acting set). The module lists the skills
 * of these and sends the selected space only when it is one of them.
 */
export function useChatActingSpaceIds(): string[] {
  const { data: spaces } = useSpaces();
  const orgPermissions = useOrg().currentOrg?.permissions;
  return useMemo(
    () => actingSpaces(spaces, orgPermissions).map((space) => space.id),
    [spaces, orgPermissions],
  );
}

/** The caller's grant in a named space: what a call of a conversation did there (its run, its files). */
export function useChatCanIn() {
  return useRowSpaceGrants();
}
