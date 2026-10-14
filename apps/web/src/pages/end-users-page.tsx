// SPDX-License-Identifier: Apache-2.0

import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Users } from "lucide-react";
import { usePermissions } from "../hooks/use-permissions";
import { Button } from "@appstrate/ui/components/button";
import {
  useDeleteEndUser,
  useEndUser,
  useEndUsers,
  type EndUserInfo,
} from "../hooks/use-end-users";
import { useCurrentSpaceId } from "../hooks/use-current-space";
import { ErrorState, EmptyState, EmptyStateAction, NoMatchState } from "../components/page-states";
import { SettingsSkeleton } from "../components/loading-skeletons";
import { useModalParam } from "../hooks/use-modal-param";
import { EndUserCreateModal } from "../components/end-user-create-modal";
import { EndUserDetailModal } from "../components/end-user-detail-modal";
import { ConfirmModal } from "../components/confirm-modal";
import { Modal } from "../components/modal";
import { DataTable } from "../components/data-table";
import { columnMenu, visibleColumns } from "../lib/column-visibility";
import { ListToolbar } from "../components/list-toolbar";
import { SettingsPageActions } from "../components/settings/settings-page-actions";
import type { PageAction } from "../components/page-actions-menu";
import { useColumnVisibility } from "../stores/column-visibility-store";
import { endUserDisplayName, useEndUserColumns } from "./end-user-columns";

const END_USER_PARAM = "endUser";
const EDIT_END_USER_PARAM = "editEndUser";

export function EndUsersPage() {
  // Remount on space switch so cursor + loadedPages (and the rest of the
  // page state) reset — otherwise space A's accumulated "Load more" pages would
  // bleed into space B's list.
  const spaceId = useCurrentSpaceId();
  return <EndUsersPageContent key={spaceId ?? "none"} />;
}

function EndUsersPageContent() {
  const { t } = useTranslation(["settings", "common"]);
  const { can } = usePermissions();
  const canWrite = can("end-users:write");
  const spaceId = useCurrentSpaceId();

  const [search, setSearch] = useState("");
  const newEndUser = useModalParam("newEndUser");
  const [pendingDelete, setPendingDelete] = useState<EndUserInfo | null>(null);
  const [deletedUserIds, setDeletedUserIds] = useState<ReadonlySet<string>>(() => new Set());
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  // Pages loaded before the current cursor. "Load more" appends the current
  // page here and advances the cursor, so the list accumulates across pages
  // instead of the newest page replacing the previous one.
  const [loadedPages, setLoadedPages] = useState<EndUserInfo[]>([]);

  const { data, isLoading, error } = useEndUsers({
    limit: 25,
    startingAfter: cursor,
  });

  const currentPage = useMemo(() => data?.data ?? [], [data?.data]);
  const hasMore = data?.hasMore ?? false;
  // The detail and the edition are two addresses of one modal: `?endUser=<id>`
  // shows, `?editEndUser=<id>` edits, and switching hands one over to the other.
  const detailParam = useModalParam(END_USER_PARAM);
  const editParam = useModalParam(EDIT_END_USER_PARAM);
  const selectedUserId = editParam.value ?? detailParam.value;
  const {
    data: selectedUserDetail,
    isLoading: selectedUserLoading,
    error: selectedUserError,
  } = useEndUser(selectedUserId ?? "");
  const deleteMutation = useDeleteEndUser();

  // Merge accumulated pages with the current one, deduping by id (the current
  // page briefly overlaps the accumulator between "Load more" and the next
  // fetch settling).
  const endUsers = useMemo(() => {
    const seen = new Set<string>();
    const out: EndUserInfo[] = [];
    for (const u of [...loadedPages, ...currentPage]) {
      if (deletedUserIds.has(u.id)) continue;
      if (!seen.has(u.id)) {
        seen.add(u.id);
        out.push(u);
      }
    }
    return out;
  }, [loadedPages, currentPage, deletedUserIds]);

  const filtered = useMemo(() => {
    if (!search.trim()) return endUsers;
    const q = search.toLowerCase();
    return endUsers.filter(
      (u) =>
        u.name?.toLowerCase().includes(q) ||
        u.email?.toLowerCase().includes(q) ||
        u.externalId?.toLowerCase().includes(q) ||
        u.id.toLowerCase().includes(q),
    );
  }, [endUsers, search]);

  const selectedUser = selectedUserId
    ? (selectedUserDetail ?? endUsers.find((user) => user.id === selectedUserId) ?? null)
    : null;

  const closeUser = editParam.value !== null ? editParam.close : detailParam.close;

  const hideDeletedUser = (id: string) => {
    setDeletedUserIds((previous) => new Set(previous).add(id));
    setLoadedPages((previous) => previous.filter((user) => user.id !== id));
  };

  const allColumns = useEndUserColumns({
    deletingUserId: deleteMutation.isPending
      ? (deleteMutation.variables?.params.path.id ?? null)
      : null,
    onEdit: (user) => editParam.open(user.id),
    onDelete: setPendingDelete,
  });
  const visibility = useColumnVisibility("end-users");
  const columns = visibleColumns(allColumns, visibility.hidden);

  const create: PageAction = {
    id: "create",
    icon: Plus,
    label: t("spaces.newEndUser"),
    onSelect: () => newEndUser.open(),
    hidden: !canWrite,
  };

  if (!spaceId) return <EmptyState message={t("spaces.noSpaceSelected")} icon={Users} />;

  // Reading is the route's gate (`end-users:read`); creating and editing need
  // `end-users:write`, deleting `end-users:delete` (the row menu checks it).
  return (
    <div>
      <SettingsPageActions actions={[create]} />

      <ListToolbar
        search={{
          value: search,
          onChange: setSearch,
          placeholder: t("spaces.searchEndUsers"),
        }}
        filters={[]}
        columns={columnMenu(allColumns, visibility)}
      />

      <DataTable
        tableId="end-users"
        label={t("endUsers.pageTitle")}
        columns={columns}
        rows={filtered}
        rowKey={(user) => user.id}
        rowAction={(user) => detailParam.open(user.id)}
        rowLabel={(user) =>
          t("spaces.openEndUser", {
            name: endUserDisplayName(user, t("spaces.anonymousUser")),
          })
        }
        isLoading={isLoading}
        failure={error}
        empty={
          search.trim() ? (
            <NoMatchState message={t("spaces.noMatchingEndUsers")} />
          ) : (
            <EmptyState
              message={t("spaces.noEndUsers")}
              hint={t("spaces.noEndUsersHint")}
              icon={Users}
              compact
            >
              <EmptyStateAction action={create} />
            </EmptyState>
          )
        }
      />

      {hasMore && !isLoading && !error && (
        <Button
          variant="outline"
          onClick={() => {
            const last = currentPage[currentPage.length - 1];
            if (last) {
              setLoadedPages((prev) => [...prev, ...currentPage]);
              setCursor(last.id);
            }
          }}
          className="mt-3 w-full"
        >
          {t("spaces.loadMore")}
        </Button>
      )}

      {canWrite && newEndUser.value !== null && <EndUserCreateModal onClose={newEndUser.close} />}

      {selectedUserId && selectedUser && (
        <EndUserDetailModal
          key={selectedUserId}
          onClose={closeUser}
          endUser={selectedUser}
          editing={canWrite && editParam.value !== null}
          onEdit={() => editParam.open(selectedUserId, END_USER_PARAM)}
          onShowDetail={() => detailParam.open(selectedUserId, EDIT_END_USER_PARAM)}
          onDeleted={hideDeletedUser}
        />
      )}

      {selectedUserId && !selectedUser && (
        <Modal open onClose={closeUser} title={t("spaces.endUserDetail")}>
          {selectedUserLoading ? (
            <SettingsSkeleton />
          ) : (
            <ErrorState error={selectedUserError} compact />
          )}
        </Modal>
      )}

      <ConfirmModal
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title={t("spaces.deleteEndUserTitle")}
        confirmLabel={t("common:btn.delete")}
        description={t("spaces.deleteEndUserConfirm")}
        isPending={deleteMutation.isPending}
        onConfirm={async () => {
          if (!pendingDelete) return;
          const user = pendingDelete;
          try {
            await deleteMutation.mutateAsync({ params: { path: { id: user.id } } });
            hideDeletedUser(user.id);
            setPendingDelete(null);
          } catch {
            // The mutation cache toasts the refusal and the dialog closes on it.
          }
        }}
      />
    </div>
  );
}
