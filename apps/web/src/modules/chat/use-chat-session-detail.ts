// SPDX-License-Identifier: Apache-2.0

import { $api } from "../../api/client";
import { useCurrentOrgId } from "../../hooks/use-org";

/**
 * A stored conversation read by id from the organization's routes, which name no space: its title,
 * the spaces it touched and its info. One query for the title crumb, the spaces control and the
 * info panel, refetched by the session signal. Off without a conversation or while `enabled` is false.
 */
export function useChatSessionDetail(conversationId: string | null, enabled = true) {
  const orgId = useCurrentOrgId();
  return $api.useQuery(
    "get",
    "/api/orgs/{orgId}/chat/sessions/{id}",
    { params: { path: { orgId: orgId ?? "", id: conversationId ?? "" } } },
    { enabled: !!orgId && !!conversationId && enabled },
  );
}
