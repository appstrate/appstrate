// SPDX-License-Identifier: Apache-2.0

import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../i18n";
import { Search, Users } from "lucide-react";
import { usePermissions } from "../hooks/use-permissions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useEndUsers, type EndUserInfo } from "../hooks/use-end-users";
import { useCurrentApplicationId } from "../hooks/use-current-application";
import { PageHeader } from "../components/page-header";
import { LoadingState, ErrorState, EmptyState } from "../components/page-states";
import { EndUserCreateModal } from "../components/end-user-create-modal";
import { EndUserDetailModal } from "../components/end-user-detail-modal";

/** Deterministic color from ID hash for the avatar circle. */
const AVATAR_COLORS = [
  "bg-blue-500/20 text-blue-600 dark:text-blue-400",
  "bg-emerald-500/20 text-emerald-600 dark:text-emerald-400",
  "bg-violet-500/20 text-violet-600 dark:text-violet-400",
  "bg-amber-500/20 text-amber-600 dark:text-amber-400",
  "bg-rose-500/20 text-rose-600 dark:text-rose-400",
  "bg-cyan-500/20 text-cyan-600 dark:text-cyan-400",
  "bg-fuchsia-500/20 text-fuchsia-600 dark:text-fuchsia-400",
  "bg-orange-500/20 text-orange-600 dark:text-orange-400",
];

function hashCode(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function getInitials(name: string | null, email: string | null): string {
  if (name) {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
    return name.slice(0, 2).toUpperCase();
  }
  if (email) return email.slice(0, 2).toUpperCase();
  return "?";
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(i18n.language, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function EndUserAvatar({ user }: { user: EndUserInfo }) {
  const color = AVATAR_COLORS[hashCode(user.id) % AVATAR_COLORS.length]!;
  return (
    <div
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[0.7rem] font-semibold ${color}`}
    >
      {getInitials(user.name, user.email)}
    </div>
  );
}

export function EndUsersPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { isAdmin } = usePermissions();
  const appId = useCurrentApplicationId();

  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedUser, setSelectedUser] = useState<EndUserInfo | null>(null);
  const [cursor, setCursor] = useState<string | undefined>(undefined);

  const { data, isLoading, error } = useEndUsers({
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
        <TooltipProvider delayDuration={300}>
          <div className="flex flex-col gap-2">
            {filtered.map((user) => {
              const metaCount = user.metadata ? Object.keys(user.metadata).length : 0;
              return (
                <div
                  key={user.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedUser(user)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") setSelectedUser(user);
                  }}
                  className="border-border bg-card hover:border-primary/30 cursor-pointer rounded-lg border px-4 py-3 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <EndUserAvatar user={user} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-semibold">
                          {user.name || user.email || t("applications.anonymousUser")}
                        </span>
                        {user.email && user.name && (
                          <span className="text-muted-foreground truncate text-sm">
                            {user.email}
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Badge
                              variant="secondary"
                              className="cursor-default px-1.5 py-0 text-[0.65rem] opacity-60"
                            >
                              {user.id.length > 20 ? `${user.id.slice(0, 20)}...` : user.id}
                            </Badge>
                          </TooltipTrigger>
                          <TooltipContent side="bottom">
                            <span className="font-mono text-xs">{user.id}</span>
                          </TooltipContent>
                        </Tooltip>
                        {user.externalId && (
                          <Badge variant="outline" className="px-1.5 py-0 text-[0.65rem]">
                            {user.externalId}
                          </Badge>
                        )}
                        {metaCount > 0 && (
                          <Badge variant="outline" className="px-1.5 py-0 text-[0.65rem]">
                            {t("applications.metadataCount", { count: metaCount })}
                          </Badge>
                        )}
                      </div>
                    </div>
                    <span className="text-muted-foreground shrink-0 text-xs">
                      {formatDate(user.createdAt)}
                    </span>
                  </div>
                </div>
              );
            })}

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
        </TooltipProvider>
      )}

      <EndUserCreateModal open={createOpen} onClose={() => setCreateOpen(false)} />

      <EndUserDetailModal
        open={!!selectedUser}
        onClose={() => setSelectedUser(null)}
        endUser={selectedUser}
      />
    </>
  );
}
