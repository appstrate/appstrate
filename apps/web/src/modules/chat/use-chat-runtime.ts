// SPDX-License-Identifier: Apache-2.0

/** Host-provided chat inputs, shared by the sidebar list and the page thread. Must not import `@appstrate/module-chat/ui` (entry chunk). */

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import type { ChatScope } from "@appstrate/module-chat/ui";
import { useTranslation } from "react-i18next";
import { buildScopingHeaders } from "../../lib/scoping-headers";
import { useViewAsHeader } from "../../stores/view-as-store";
import { useCurrentSpaceId } from "../../hooks/use-current-space";
import { useCurrentOrgId, useOrg } from "../../hooks/use-org";
import { useOverviewMode } from "../../hooks/use-overview-mode";
import { usePermissions } from "../../hooks/use-permissions";
import { useRowSpaceGrants } from "../../hooks/use-space-action";
import { useSpaces } from "../../hooks/use-spaces";
import { actingSpaces, grantedInSomeActingSpace } from "../../lib/space-lists";
import {
  chatScopeId,
  chatTransport,
  conversationOfPath,
  scopeChangeLeavesConversation,
  type ChatPlace,
} from "./chat-transport";

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
 * What the chat serves: the organization in « Vue d'ensemble » (the chat holds the mode), else the
 * working space. `known` once the space listing has answered: before, the mode cannot be told, and a
 * chat page would ask the wrong routes.
 */
export function useChatScope(): { scope: ChatScope; known: boolean } {
  const { on, known } = useOverviewMode();
  const orgId = useCurrentOrgId();
  return useMemo(
    () => ({
      scope: on && orgId ? { kind: "organization", orgId } : { kind: "space" },
      known,
    }),
    [on, orgId, known],
  );
}

const SPACE_SCOPE: ChatScope = { kind: "space" };

/** The shell's own transport (nav badge, outside a chat page) in a space: scoping headers only, no chat locale. */
const SHELL_CHAT_TRANSPORT = chatTransport(buildScopingHeaders, SPACE_SCOPE);

/** {@link SHELL_CHAT_TRANSPORT} of the scope the chat serves: the organization's in the mode. */
export function useShellChatTransport() {
  const { scope } = useChatScope();
  return useMemo(
    () =>
      scope.kind === "space" ? SHELL_CHAT_TRANSPORT : chatTransport(buildScopingHeaders, scope),
    [scope],
  );
}

/** {@link chatTransport} over the page's headers and scope; its identity moves with them. */
export function useChatTransport() {
  const getHeaders = useChatGetHeaders();
  const { scope } = useChatScope();
  return useMemo(() => chatTransport(getHeaders, scope), [getHeaders, scope]);
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
 * The grants the chat module reads as its own: the working space's in a space, and in «Vue
 * d'ensemble» "some space where the chat may act grants it" (an organization session acts in the
 * spaces the caller names, never in the working one the overview merely keeps).
 */
export function useChatCan() {
  const { can } = usePermissions();
  const { scope } = useChatScope();
  const { data: spaces } = useSpaces();
  const orgPermissions = useOrg().currentOrg?.permissions;
  return useCallback(
    (permission: string) =>
      scope.kind === "space"
        ? can(permission)
        : grantedInSomeActingSpace(spaces, orgPermissions, permission),
    [scope.kind, can, spaces, orgPermissions],
  );
}

/**
 * The ids of the spaces an organization session acts in (the backend's acting set); undefined in a
 * space scope. The module narrows what it lists across spaces to them (the skills picker).
 */
export function useChatActingSpaceIds(): string[] | undefined {
  const { scope } = useChatScope();
  const { data: spaces } = useSpaces();
  const orgPermissions = useOrg().currentOrg?.permissions;
  return useMemo(
    () =>
      scope.kind === "space"
        ? undefined
        : actingSpaces(spaces, orgPermissions).map((space) => space.id),
    [scope.kind, spaces, orgPermissions],
  );
}

/** The caller's grant in a named space: what a call of an organization session did there. */
export function useChatCanIn() {
  return useRowSpaceGrants();
}

/**
 * Drops to a new conversation when the chat's scope changes under an open one (the switcher
 * entering or leaving «Vue d'ensemble», or another space): see `scopeChangeLeavesConversation`.
 * The one place for every way the scope changes. Silent until the scope is known.
 */
export function useLeaveConversationOnScopeChange(conversationId: string | null): void {
  const { scope, known } = useChatScope();
  const spaceId = useCurrentSpaceId();
  const navigate = useNavigate();
  const scopeId = known ? chatScopeId(scope, spaceId) : null;
  const seen = useRef<ChatPlace | null>(null);
  useEffect(() => {
    if (!scopeId) return;
    const place = { scopeId, conversationId };
    const live = conversationOfPath(window.location.pathname);
    if (scopeChangeLeavesConversation(seen.current, place, live)) {
      navigate("/chat", { replace: true });
    }
    seen.current = place;
  }, [scopeId, conversationId, navigate]);
}
