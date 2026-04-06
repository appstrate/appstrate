// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Plus, FolderOpen, Building2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "./page-states";
import { Spinner } from "./spinner";
import { useAppProfiles, useCreateAppProfile } from "../hooks/use-connection-profiles";

export function AppProfilesTab() {
  const { t } = useTranslation(["settings", "common"]);
  const { data: appProfiles, isLoading } = useAppProfiles();

  const [newName, setNewName] = useState("");
  const createMutation = useCreateAppProfile();

  const handleCreate = () => {
    const name = newName.trim();
    if (!name) return;
    createMutation.mutate(name, {
      onSuccess: () => setNewName(""),
    });
  };

  if (isLoading) return <Spinner className="mx-auto mt-8" />;

  return (
    <>
      {/* Create form */}
      <div className="mb-4 flex gap-2">
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder={t("appProfiles.namePlaceholder")}
          aria-label={t("appProfiles.namePlaceholder")}
          className="h-9 w-64"
          onKeyDown={(e) => e.key === "Enter" && handleCreate()}
        />
        <Button
          size="sm"
          onClick={handleCreate}
          disabled={!newName.trim() || createMutation.isPending}
        >
          <Plus className="mr-1 size-4" />
          {t("appProfiles.create")}
        </Button>
      </div>

      {appProfiles && appProfiles.length === 0 ? (
        <EmptyState
          message={t("appProfiles.empty")}
          hint={t("appProfiles.emptyHint")}
          icon={FolderOpen}
        />
      ) : (
        <div className="space-y-2">
          {appProfiles?.map((profile) => (
            <Link
              key={profile.id}
              to={`/app-profiles/${profile.id}`}
              className="border-border bg-card hover:bg-accent/50 flex items-center gap-3 rounded-lg border p-3 transition-colors"
            >
              <Building2 className="text-muted-foreground size-4 shrink-0" />
              <span className="font-medium">{profile.name}</span>
              <span className="text-muted-foreground text-xs">
                {t("appProfiles.bindingCount", { count: profile.bindingCount })}
              </span>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
