// SPDX-License-Identifier: Apache-2.0

import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Plus, SearchX, Users } from "lucide-react";
import { usePermissions } from "../hooks/use-permissions";
import { getErrorMessage } from "@appstrate/core/errors";
import { Button } from "@appstrate/ui/components/button";
import { DropdownMenuItem } from "@appstrate/ui/components/dropdown-menu";
import {
  useDeleteEndUser,
  useEndUser,
  useEndUsers,
  type EndUserInfo,
} from "../hooks/use-end-users";
import { useCurrentApplicationId } from "../hooks/use-current-application";
import { LoadingState, ErrorState, EmptyState } from "../components/page-states";
import { EndUserCreateModal } from "../components/end-user-create-modal";
import { EndUserDetailModal } from "../components/end-user-detail-modal";
import { ConfirmModal } from "../components/confirm-modal";
import { Modal } from "../components/modal";
import { DataTable, columnMenu, visibleColumns } from "../components/data-table";
import { ListToolbar } from "../components/list-toolbar";
import { SettingsPageActions } from "../components/settings/settings-page-actions";
import { PageActionsMenu } from "../components/page-actions-menu";
import { useColumnVisibility } from "../stores/column-visibility-store";
import { endUserDisplayName, useEndUserColumns } from "./end-user-columns";
import { endUserHref, endUsersHref } from "./end-user-route";

export function EndUsersPage() {
  // Remount on application switch so cursor + loadedPages (and the rest of the
  // page state) reset — otherwise app A's accumulated "Load more" pages would
  // bleed into app B's list.
  const applicationId = useCurrentApplicationId();
  return <EndUsersPageContent key={applicationId ?? "none"} />;
}

function EndUsersPageContent() {
  const { t } = useTranslation(["settings", "common"]);
  const { isAdmin } = usePermissions();
  const applicationId = useCurrentApplicationId();
  const location = useLocation();
  const navigate = useNavigate();

  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
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
  const params = new URLSearchParams(location.search);
  const selectedUserId = params.get("user");
  const editSelectedUser = params.get("edit") === "1";
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

  const closeUser = () => {
    navigate(endUsersHref(location), { replace: true, state: location.state });
  };

  const setEditMode = (id: string, editing: boolean) => {
    navigate(endUserHref(location, id, editing), {
      replace: true,
      state: location.state,
    });
  };

  const hideDeletedUser = (id: string) => {
    setDeletedUserIds((previous) => new Set(previous).add(id));
    setLoadedPages((previous) => previous.filter((user) => user.id !== id));
  };

  const allColumns = useEndUserColumns({
    deletingUserId: deleteMutation.isPending
      ? (deleteMutation.variables?.params.path.id ?? null)
      : null,
    onEdit: (user) => navigate(endUserHref(location, user.id, true), { state: location.state }),
    onDelete: setPendingDelete,
  });
  const visibility = useColumnVisibility("end-users");
  const columns = visibleColumns(allColumns, visibility.hidden);

  if (!isAdmin) return null;
  if (!applicationId) return <EmptyState message={t("applications.noAppSelected")} icon={Users} />;

  return (
    <div>
      <SettingsPageActions>
        <PageActionsMenu>
          <DropdownMenuItem data-page-action="create" onSelect={() => setCreateOpen(true)}>
            <Plus />
            {t("applications.newEndUser")}
          </DropdownMenuItem>
        </PageActionsMenu>
      </SettingsPageActions>

      <ListToolbar
        search={{
          value: search,
          onChange: setSearch,
          placeholder: t("applications.searchEndUsers"),
        }}
        filters={[]}
        columns={columnMenu(allColumns, visibility)}
      />

      <DataTable
        label={t("endUsers.pageTitle")}
        columns={columns}
        rows={filtered}
        rowKey={(user) => user.id}
        rowHref={(user) => endUserHref(location, user.id)}
        rowState={() => location.state}
        rowLabel={(user) =>
          t("applications.openEndUser", {
            name: endUserDisplayName(user, t("applications.anonymousUser")),
          })
        }
        isLoading={isLoading}
        isError={Boolean(error)}
        error={<ErrorState message={getErrorMessage(error)} compact />}
        empty={
          search.trim() ? (
            <EmptyState message={t("applications.noMatchingEndUsers")} icon={SearchX} compact />
          ) : (
            <EmptyState
              message={t("applications.noEndUsers")}
              hint={t("applications.noEndUsersHint")}
              icon={Users}
              compact
            />
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
          {t("applications.loadMore")}
        </Button>
      )}

      <EndUserCreateModal open={createOpen} onClose={() => setCreateOpen(false)} />

      {selectedUserId && selectedUser && (
        <EndUserDetailModal
          key={`${selectedUserId}:${editSelectedUser ? "edit" : "detail"}`}
          open
          onClose={closeUser}
          endUser={selectedUser}
          initialEditing={editSelectedUser}
          onEditingChange={(editing) => setEditMode(selectedUserId, editing)}
          onDeleted={hideDeletedUser}
        />
      )}

      {selectedUserId && !selectedUser && (
        <Modal open onClose={closeUser} title={t("applications.endUserDetail")}>
          {selectedUserLoading ? (
            <LoadingState />
          ) : (
            <ErrorState message={getErrorMessage(selectedUserError)} compact />
          )}
        </Modal>
      )}

      <ConfirmModal
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title={t("common:btn.confirm")}
        description={t("applications.deleteEndUserConfirm")}
        isPending={deleteMutation.isPending}
        onConfirm={async () => {
          if (!pendingDelete) return;
          const user = pendingDelete;
          try {
            await deleteMutation.mutateAsync({ params: { path: { id: user.id } } });
            hideDeletedUser(user.id);
            setPendingDelete(null);
          } catch (error) {
            toast.error(getErrorMessage(error));
          }
        }}
      />
    </div>
  );
}
