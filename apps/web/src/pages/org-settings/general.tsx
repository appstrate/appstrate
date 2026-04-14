// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Building } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "../../api";
import { useOrg } from "../../hooks/use-org";
import { usePermissions } from "../../hooks/use-permissions";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ConfirmModal } from "../../components/confirm-modal";
import { Spinner } from "../../components/spinner";
import { EmptyState } from "../../components/page-states";
import { toast } from "sonner";

export function OrgSettingsGeneralPage() {
  const { t } = useTranslation(["settings", "common"]);
  const navigate = useNavigate();
  const { currentOrg } = useOrg();
  const { isOwner, isAdmin } = usePermissions();
  const queryClient = useQueryClient();
  const orgId = currentOrg?.id;

  const [editingName, setEditingName] = useState(false);
  const [newName, setNewName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const updateNameMutation = useMutation({
    mutationFn: async (name: string) => {
      return api(`/orgs/${orgId}`, {
        method: "PUT",
        body: JSON.stringify({ name }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["orgs"] });
      setEditingName(false);
    },
    onError: (err: Error) => {
      toast.error(t("error.prefix", { message: err.message }));
    },
  });

  const deleteOrgMutation = useMutation({
    mutationFn: async () => {
      return api(`/orgs/${orgId}`, { method: "DELETE" });
    },
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: ["orgs"] });
      navigate("/");
      window.location.reload();
    },
    onError: (err: Error) => {
      toast.error(t("error.prefix", { message: err.message }));
    },
  });

  if (!currentOrg) {
    return <EmptyState message={t("orgSettings.noOrg")} icon={Building} />;
  }

  const handleSaveName = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const trimmed = newName.trim();
    if (!trimmed) return;
    updateNameMutation.mutate(trimmed);
  };

  return (
    <>
      <div className="text-muted-foreground mb-4 text-sm font-medium">
        {t("orgSettings.orgTitle")}
      </div>
      <div className="border-border bg-card mb-4 rounded-lg border p-5">
        <div className="flex items-center gap-3">
          <div className="flex-1">
            {editingName ? (
              <form onSubmit={handleSaveName} className="flex items-center gap-2">
                <Input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder={currentOrg.name}
                  autoFocus
                />
                <Button type="submit" disabled={updateNameMutation.isPending}>
                  {updateNameMutation.isPending ? <Spinner /> : t("btn.save")}
                </Button>
                <Button type="button" variant="ghost" onClick={() => setEditingName(false)}>
                  {t("btn.cancel")}
                </Button>
              </form>
            ) : (
              <>
                <h3 className="text-[0.95rem] font-semibold">{currentOrg.name}</h3>
                <span className="text-muted-foreground text-sm">{currentOrg.slug}</span>
              </>
            )}
          </div>
          {isAdmin && !editingName && (
            <Button
              variant="outline"
              onClick={() => {
                setNewName(currentOrg.name);
                setEditingName(true);
              }}
            >
              {t("btn.edit")}
            </Button>
          )}
        </div>
      </div>

      {isOwner && (
        <>
          <div className="text-muted-foreground mt-8 mb-4 text-sm font-medium">
            {t("orgSettings.dangerZone")}
          </div>
          <div className="border-destructive bg-card rounded-lg border p-5">
            <div className="flex items-center gap-3">
              <div className="flex-1">
                <h3 className="text-sm font-semibold">{t("orgSettings.deleteOrg")}</h3>
                <span className="text-muted-foreground text-sm">
                  {t("orgSettings.deleteOrgDesc")}
                </span>
              </div>
              <Button
                variant="destructive"
                disabled={deleteOrgMutation.isPending}
                onClick={() => setConfirmDelete(true)}
              >
                {deleteOrgMutation.isPending ? t("orgSettings.deleting") : t("btn.delete")}
              </Button>
            </div>
          </div>
        </>
      )}

      <ConfirmModal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={t("orgSettings.deleteOrg")}
        description={t("orgSettings.deleteConfirm", { name: currentOrg.name })}
        isPending={deleteOrgMutation.isPending}
        onConfirm={() => deleteOrgMutation.mutate()}
      />
    </>
  );
}
