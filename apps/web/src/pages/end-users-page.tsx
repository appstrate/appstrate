// SPDX-License-Identifier: Apache-2.0

import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Search, Users } from "lucide-react";
import { usePermissions } from "../hooks/use-permissions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useEndUsers, type EndUserInfo } from "../hooks/use-end-users";
import { useCurrentApplicationId } from "../hooks/use-current-application";
import { PageHeader } from "../components/page-header";
import { LoadingState, ErrorState, EmptyState } from "../components/page-states";
import { EndUserCreateModal } from "../components/end-user-create-modal";
import { EndUserDetailModal } from "../components/end-user-detail-modal";

export function EndUsersPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { isAdmin } = usePermissions();
  const appId = useCurrentApplicationId();

  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedUser, setSelectedUser] = useState<EndUserInfo | null>(null);
  const [cursor, setCursor] = useState<string | undefined>(undefined);

  const { data, isLoading, error } = useEndUsers({
    applicationId: appId ?? undefined,
    limit: 25,
    startingAfter: cursor,
  });

  const endUsers = useMemo(() => data?.data ?? [], [data?.data]);
  const hasMore = data?.hasMore ?? false;

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

  if (!isAdmin) return null;
  if (!appId) return <EmptyState message={t("applications.noAppSelected")} icon={Users} />;
  if (error) return <ErrorState message={error.message} />;

  return (
    <>
      <PageHeader
        title={t("endUsers.pageTitle")}
        emoji="👥"
        breadcrumbs={[
          { label: t("nav.orgSection", { ns: "common" }), href: "/" },
          { label: t("endUsers.pageTitle") },
        ]}
        actions={
          <Button onClick={() => setCreateOpen(true)}>{t("applications.newEndUser")}</Button>
        }
      />

      <div className="relative mb-4">
        <Search
          size={16}
          className="text-muted-foreground absolute top-1/2 left-3 -translate-y-1/2"
        />
        <Input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("applications.searchEndUsers")}
          className="pl-9"
        />
      </div>

      {isLoading ? (
        <LoadingState />
      ) : filtered.length === 0 ? (
        <EmptyState
          message={t("applications.noEndUsers")}
          hint={t("applications.noEndUsersHint")}
          icon={Users}
        >
          <Button onClick={() => setCreateOpen(true)}>{t("applications.newEndUser")}</Button>
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-3">
          {filtered.map((user) => (
            <button
              key={user.id}
              type="button"
              onClick={() => setSelectedUser(user)}
              className="border-border bg-card hover:border-primary/30 w-full rounded-lg border p-5 text-left transition-colors"
            >
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-semibold">
                    {user.name || user.email || t("applications.anonymousUser")}
                  </h3>
                  {user.email && (
                    <span className="text-muted-foreground text-sm">{user.email}</span>
                  )}
                  {user.externalId && (
                    <p className="text-muted-foreground mt-0.5 text-xs">
                      {t("applications.endUserExternalId")}: {user.externalId}
                    </p>
                  )}
                </div>
                <span className="text-muted-foreground shrink-0 font-mono text-xs">
                  {user.id.length > 16 ? `${user.id.slice(0, 16)}...` : user.id}
                </span>
              </div>
            </button>
          ))}

          {hasMore && (
            <Button
              variant="outline"
              onClick={() => {
                const last = endUsers[endUsers.length - 1];
                if (last) setCursor(last.id);
              }}
              className="mt-2"
            >
              {t("applications.loadMore")}
            </Button>
          )}
        </div>
      )}

      <EndUserCreateModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        applicationId={appId}
      />

      <EndUserDetailModal
        open={!!selectedUser}
        onClose={() => setSelectedUser(null)}
        endUser={selectedUser}
      />
    </>
  );
}
