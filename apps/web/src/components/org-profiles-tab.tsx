import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Plus, FolderOpen, Building2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "./page-states";
import { Spinner } from "./spinner";
import { useOrgProfiles, useCreateOrgProfile } from "../hooks/use-connection-profiles";

export function OrgProfilesTab() {
  const { t } = useTranslation(["settings", "common"]);
  const { data: orgProfiles, isLoading } = useOrgProfiles();

  const [newName, setNewName] = useState("");
  const createMutation = useCreateOrgProfile();

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
      <div className="flex gap-2 mb-4">
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder={t("orgProfiles.namePlaceholder")}
          aria-label={t("orgProfiles.namePlaceholder")}
          className="h-9 w-64"
          onKeyDown={(e) => e.key === "Enter" && handleCreate()}
        />
        <Button
          size="sm"
          onClick={handleCreate}
          disabled={!newName.trim() || createMutation.isPending}
        >
          <Plus className="size-4 mr-1" />
          {t("orgProfiles.create")}
        </Button>
      </div>

      {orgProfiles && orgProfiles.length === 0 ? (
        <EmptyState
          message={t("orgProfiles.empty")}
          hint={t("orgProfiles.emptyHint")}
          icon={FolderOpen}
        />
      ) : (
        <div className="space-y-2">
          {orgProfiles?.map((profile) => (
            <Link
              key={profile.id}
              to={`/org-profiles/${profile.id}`}
              className="flex items-center gap-3 rounded-lg border border-border bg-card p-3 hover:bg-accent/50 transition-colors"
            >
              <Building2 className="size-4 text-muted-foreground shrink-0" />
              <span className="font-medium">{profile.name}</span>
              <span className="text-xs text-muted-foreground">
                {t("orgProfiles.bindingCount", { count: profile.bindingCount })}
              </span>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
