// SPDX-License-Identifier: Apache-2.0

import { ActivityIcon, FilesIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { MimeIcon } from "@appstrate/ui/components/mime-icon";
import { EmptyState, ErrorState } from "../../components/page-states";
import { RowSpaceName, RunRow } from "../../components/run-row";
import { TextSkeleton } from "../../components/loading-skeletons";
import { formatBytes } from "../../lib/format-bytes";
import { formatDateField } from "../../lib/format-date";
import type { StoredSidebarFile } from "./conversation-sidebar-state";
import { useConversationFiles, useConversationRuns } from "./use-conversation-lists";

/** The runs a conversation launched, newest first. */
export function ConversationRuns({
  conversationId,
  active,
}: {
  conversationId: string | null;
  active: boolean;
}) {
  const { t } = useTranslation("chat");
  const { query, runs, agentName, agentById, spanning } = useConversationRuns(
    conversationId,
    active,
  );

  if (!conversationId) {
    return <EmptyState message={t("context.unsaved")} icon={ActivityIcon} compact />;
  }
  if (query.error) return <ErrorState error={query.error} compact />;
  // Pending covers a read not yet answered and one held while the panel is closed.
  if (query.isPending) return <TextSkeleton className="p-4" />;
  if (runs.length === 0) {
    return <EmptyState message={t("context.runs.empty")} icon={ActivityIcon} compact />;
  }

  return (
    <div className="divide-y">
      {runs.map((run) => (
        <RunRow
          key={run.id}
          run={run}
          agentName={agentName(run)}
          agent={run.packageId ? agentById.get(run.packageId) : undefined}
          dense
          spanning={spanning}
          className="px-3"
        />
      ))}
    </div>
  );
}

/** The files of a conversation, newest first. */
export function ConversationFiles({
  conversationId,
  active,
  onSelect,
}: {
  conversationId: string | null;
  active: boolean;
  onSelect: (file: StoredSidebarFile) => void;
}) {
  const { t } = useTranslation("chat");
  const { query, files, named } = useConversationFiles(conversationId, active);

  if (!conversationId) {
    return <EmptyState message={t("context.unsaved")} icon={FilesIcon} compact />;
  }
  if (query.error) return <ErrorState error={query.error} compact />;
  if (query.isPending) return <TextSkeleton className="p-4" />;
  if (files.length === 0) {
    return <EmptyState message={t("context.files.empty")} icon={FilesIcon} compact />;
  }

  return (
    <div className="divide-y">
      {files.map((file) => (
        <button
          key={file.id}
          type="button"
          className="hover:bg-muted/50 flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left transition-colors"
          onClick={() => onSelect({ id: file.id, name: file.name, spaceId: file.spaceId })}
        >
          <span className="bg-muted flex size-8 shrink-0 items-center justify-center rounded-lg">
            <MimeIcon mime={file.mime} name={file.name} className="text-muted-foreground size-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{file.name}</span>
            <span className="text-muted-foreground block truncate text-xs">
              {[
                file.purpose === "user_upload"
                  ? t("context.files.attachment")
                  : t("context.files.output"),
                formatBytes(file.size),
                formatDateField(file.createdAt, "date"),
              ].join(" · ")}
            </span>
          </span>
          {named && <RowSpaceName spaceId={file.spaceId} />}
        </button>
      ))}
    </div>
  );
}
