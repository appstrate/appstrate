// SPDX-License-Identifier: Apache-2.0

import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Users } from "lucide-react";
import { usePermissions } from "../hooks/use-permissions";
import { Button } from "@appstrate/ui/components/button";
import {
  useDeleteEndUser,
  useEndUser,
  useEndUsersPaged,
  type EndUserInfo,
} from "../hooks/use-end-users";
import { useDebouncedValue } from "../hooks/use-debounced-value";
import { useCurrentSpaceId } from "../hooks/use-current-space";
import { ErrorState, EmptyState, EmptyStateAction, NoMatchState } from "../components/page-states";
import { SettingsSkeleton } from "../components/loading-skeletons";
import { useModalParam } from "../hooks/use-modal-param";
import { EndUserCreateModal } from "../components/end-user-create-modal";
import { EndUserDetailModal } from "../components/end-user-detail-modal";
import { Spinner } from "@appstrate/ui/components/spinner";
import { ConfirmModal } from "../components/confirm-modal";
import { Modal } from "../components/modal";
import { DataTable } from "../components/data-table";
import { columnMenu, visibleColumns } from "../lib/column-visibility";
import { ListToolbar } from "../components/list-toolbar";
import { SettingsPageActions } from "../components/settings/settings-page-actions";
import type { MenuAction } from "../components/menu-action";
import { useColumnVisibility } from "../stores/column-visibility-store";
import { endUserLabel } from "../lib/members";
import { useEndUserColumns } from "./end-user-columns";

const END_USER_PARAM = "endUser";
const EDIT_END_USER_PARAM = "editEndUser";

export function EndUsersPage() {
  // Remount on space switch so the loaded pages (and the rest of the page state)
  // reset — otherwise space A's pages would bleed into space B's list.
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
  const query = useDebouncedValue(search).trim();

  const { data, isLoading, error, hasNextPage, fetchNextPage, isFetchingNextPage } =
    useEndUsersPaged({ search: query });
  const endUsers = useMemo(() => data?.pages.flatMap((page) => page.data) ?? [], [data]);
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

  const selectedUser = selectedUserId
    ? (selectedUserDetail ?? endUsers.find((user) => user.id === selectedUserId) ?? null)
    : null;

  const closeUser = editParam.value !== null ? editParam.close : detailParam.close;

  const allColumns = useEndUserColumns({
    deletingUserId: deleteMutation.isPending
      ? (deleteMutation.variables?.params.path.id ?? null)
      : null,
    onEdit: (user) => editParam.open(user.id),
    onDelete: setPendingDelete,
  });
  const visibility = useColumnVisibility("end-users");
  const columns = visibleColumns(allColumns, visibility.hidden);

  const create: MenuAction = {
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
        rows={endUsers}
        rowKey={(user) => user.id}
        rowAction={(user) => detailParam.open(user.id)}
        rowLabel={(user) =>
          t("spaces.openEndUser", {
            name: endUserLabel(user, t("spaces.anonymousUser")),
          })
        }
        isLoading={isLoading && endUsers.length === 0}
        failure={error}
        empty={
          query ? (
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

      {hasNextPage && !isLoading && !error && (
        <Button
          variant="outline"
          disabled={isFetchingNextPage}
          onClick={() => void fetchNextPage()}
          className="mt-3 w-full"
        >
          {isFetchingNextPage ? <Spinner /> : t("spaces.loadMore")}
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
            setPendingDelete(null);
          } catch {
            // The mutation cache toasts the refusal and the dialog closes on it.
          }
        }}
      />
    </div>
  );
}
