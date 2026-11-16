// SPDX-License-Identifier: Apache-2.0

/**
 * Publishes the chat's place in the shell's trail, like any page: "Chat" on a new conversation,
 * "Chat / <conversation>" inside one (the parent links back to a new conversation). The name
 * is a plain segment; renaming lives in the conversation's settings dialog.
 *
 * Next to the name, the spaces the conversation touched (tile and name each), read from the
 * conversation itself (the list's row meanwhile): they follow its refetch when it touches a new
 * one, and are not drawn for a conversation that touched none.
 *
 * The name comes from the conversation list while it holds the row (renames and the first title land
 * there live) and from the conversation itself otherwise: a conversation belongs to the organization,
 * so one opened from outside the list's space filter keeps its name.
 *
 * While sessions load (or cannot be asked yet, `pending`) a skeleton slot reserves the space; an unknown (deleted) conversation
 * publishes "Chat" alone rather than a made-up name.
 */

import { useTranslation } from "react-i18next";
import { useSessions } from "@appstrate/module-chat/unread";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { $api } from "@/api/client";
import { useCurrentOrgId } from "@/hooks/use-org";
import { usePageBreadcrumb } from "@/hooks/use-overlay-breadcrumb";
import { ShellTrailContent } from "@/components/shell-breadcrumb";
import { SpaceNamesRow } from "@/components/space-name";
import { useSpacesOf } from "@/hooks/use-spaces";
import { chatTrailEntries, resolveCrumbTitle } from "./chat-crumb-title";

export function ChatTitleCrumb({
  conversationId,
  pending = false,
}: {
  conversationId: string | null;
  /** The sessions cannot be asked yet (the scope they are read in is not known): the slot is reserved. */
  pending?: boolean;
}) {
  const { t } = useTranslation(["chat", "common"]);
  const { data: sessions, isLoading } = useSessions();
  const orgId = useCurrentOrgId();
  const listed = conversationId ? sessions?.find((s) => s.id === conversationId) : undefined;
  // The conversation itself, whatever the list's filter: its name when the list lacks the row, and
  // its touched spaces. The same query as the info panel's, refetched by the session signal.
  const detail = $api.useQuery(
    "get",
    "/api/orgs/{orgId}/chat/sessions/{id}",
    { params: { path: { orgId: orgId ?? "", id: conversationId ?? "" } } },
    { enabled: !!orgId && !!conversationId && !pending },
  );
  const touched = useSpacesOf(detail.data?.space_ids ?? listed?.space_ids ?? []);
  const title = resolveCrumbTitle(listed, detail.data, t("threads.new"));

  // `isLoading`: the read is off without a space, and would wait forever.
  const loading =
    conversationId !== null && (pending || isLoading || (!listed && detail.isLoading));

  const chat = t("common:products.chat");
  usePageBreadcrumb(chatTrailEntries(chat, title, loading, touched.length));

  if (title === null && loading) {
    return (
      <ShellTrailContent>
        <Skeleton className="mx-1.5 h-4 w-40" />
      </ShellTrailContent>
    );
  }
  return title !== null && touched.length > 0 ? (
    <ShellTrailContent>
      <SpaceNamesRow spaces={touched} />
    </ShellTrailContent>
  ) : null;
}
