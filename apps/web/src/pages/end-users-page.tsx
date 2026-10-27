// SPDX-License-Identifier: Apache-2.0

import { PendingButton } from "@/components/app-ui/pending-button";
import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Users } from "lucide-react";
import { usePermissions } from "../hooks/use-permissions";
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
import { useUrlModal } from "../hooks/use-url-modal";
import { EndUserCreateModal } from "../components/end-user-create-modal";
import { EndUserDetailModal } from "../components/end-user-detail-modal";
import { ConfirmModal } from "../components/confirm-modal";
import { Modal } from "../components/modal";
import { DataTable } from "../components/data-table";
import { ListToolbar } from "../components/list-toolbar";
import { SettingsPageActions } from "../components/settings/settings-page-actions";
import type { MenuAction } from "../lib/menu-action";
import { useColumnVisibility } from "../stores/column-visibility-store";
import { endUserLabel } from "../lib/members";
import { useEndUserColumns } from "./end-user-columns";

const END_USER_PARAM = "endUser";

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
  const [creating, setCreating] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<EndUserInfo | null>(null);
  const query = useDebouncedValue(search).trim();

  const { data, isLoading, error, hasNextPage, fetchNextPage, isFetchingNextPage } =
    useEndUsersPaged({ search: query });
  const endUsers = useMemo(() => data?.pages.flatMap((page) => page.data) ?? [], [data]);
  // The detail has an address (`?endUser=<id>`); the edition is a state of the page, and
  // switching hands one over to the other.
  const detailParam = useUrlModal(END_USER_PARAM);
  const [editUserId, setEditUserId] = useState<string | null>(null);
  const selectedUserId = editUserId ?? detailParam.value;
  const {
    data: selectedUserDetail,
    isLoading: selectedUserLoading,
    error: selectedUserError,
  } = useEndUser(selectedUserId ?? "");
  const deleteMutation = useDeleteEndUser();

  const selectedUser = selectedUserId
    ? (selectedUserDetail ?? endUsers.find((user) => user.id === selectedUserId) ?? null)
    : null;

  const closeUser = editUserId !== null ? () => setEditUserId(null) : detailParam.close;

  const allColumns = useEndUserColumns({
    deletingUserId: deleteMutation.isPending
      ? (deleteMutation.variables?.params.path.id ?? null)
      : null,
    onEdit: (user) => setEditUserId(user.id),
    onDelete: setPendingDelete,
  });
  const { columns, menu } = useColumnVisibility("end-users", allColumns);

  const create: MenuAction = {
    id: "create",
    icon: Plus,
    label: t("spaces.newEndUser"),
    onSelect: () => setCreating(true),
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
        columns={menu}
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
        <PendingButton
          variant="outline"
          pending={isFetchingNextPage}
          onClick={() => void fetchNextPage()}
          className="mt-3 w-full"
        >
          {t("spaces.loadMore")}
        </PendingButton>
      )}

      {canWrite && creating && <EndUserCreateModal onClose={() => setCreating(false)} />}

      {selectedUserId && selectedUser && (
        <EndUserDetailModal
          key={selectedUserId}
          onClose={closeUser}
          endUser={selectedUser}
          editing={canWrite && editUserId !== null}
          onEdit={() => {
            detailParam.close();
            setEditUserId(selectedUserId);
          }}
          onShowDetail={() => {
            setEditUserId(null);
            detailParam.open(selectedUserId);
          }}
        />
      )}

      {selectedUserId && !selectedUser && (
        <Modal onClose={closeUser} title={t("spaces.endUserDetail")}>
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
