import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Plus, FolderOpen, Building2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "../components/page-header";
import { LoadingState, ErrorState, EmptyState } from "../components/page-states";
import { useOrg } from "../hooks/use-org";
import { useOrgProfiles, useCreateOrgProfile } from "../hooks/use-connection-profiles";

export function OrgProfilesPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { isOrgAdmin } = useOrg();
  const { data: orgProfiles, isLoading, error } = useOrgProfiles();

  const [newName, setNewName] = useState("");
  const createMutation = useCreateOrgProfile();

  const handleCreate = () => {
    const name = newName.trim();
    if (!name) return;
    createMutation.mutate(name, {
      onSuccess: () => setNewName(""),
    });
  };

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;

  return (
    <>
      <PageHeader
        title={t("common:nav.orgProfiles")}
        emoji="🏢"
        breadcrumbs={[
          { label: t("nav.orgSection", { ns: "common" }), href: "/" },
          { label: t("common:nav.orgProfiles") },
        ]}
        actions={
          isOrgAdmin ? (
            <div className="flex gap-2">
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={t("orgProfiles.namePlaceholder")}
                className="h-9 w-48"
                onKeyDown={(e) => e.key === "Enter" && handleCreate()}
              />
              <Button onClick={handleCreate} disabled={!newName.trim() || createMutation.isPending}>
                <Plus className="size-4 mr-1" />
                {t("orgProfiles.create")}
              </Button>
            </div>
          ) : undefined
        }
      />

      {orgProfiles && orgProfiles.length === 0 ? (
        <EmptyState
          message={t("orgProfiles.empty")}
          hint={isOrgAdmin ? t("orgProfiles.emptyHint") : undefined}
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
