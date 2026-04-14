// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  useConnectionProfiles,
  useCreateConnectionProfile,
  useRenameConnectionProfile,
  useDeleteConnectionProfile,
} from "../../hooks/use-connection-profiles";
import { LoadingState, ErrorState } from "../../components/page-states";
import { ConfirmModal } from "../../components/confirm-modal";

export function PreferencesProfilesPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { data: profiles, isLoading, error } = useConnectionProfiles();
  const createProfile = useCreateConnectionProfile();
  const renameProfile = useRenameConnectionProfile();
  const deleteProfile = useDeleteConnectionProfile();

  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [confirmState, setConfirmState] = useState<{ label: string; id: string } | null>(null);

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;

  const handleCreate = () => {
    if (newName.trim()) {
      createProfile.mutate(newName.trim(), {
        onSuccess: () => setNewName(""),
      });
    }
  };

  return (
    <>
      <div className="text-muted-foreground mb-4 text-sm font-medium">{t("profiles.title")}</div>

      <div className="border-border bg-card mb-4 rounded-lg border p-5">
        <div className="flex items-center gap-2 py-1">
          <Input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={t("profiles.namePlaceholder")}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newName.trim() && !createProfile.isPending) handleCreate();
            }}
          />
          <Button onClick={handleCreate} disabled={!newName.trim() || createProfile.isPending}>
            {t("profiles.create")}
          </Button>
        </div>
      </div>

      {profiles && profiles.length > 0 && (
        <div className="flex flex-col gap-3">
          {profiles.map((profile) => (
            <div key={profile.id} className="border-border bg-card rounded-lg border p-5">
              <div className="mb-3 flex items-center gap-3">
                <div className="flex-1">
                  {editingId === profile.id ? (
                    <div className="flex items-center gap-2">
                      <Input
                        type="text"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && editName.trim()) {
                            renameProfile.mutate(
                              { id: profile.id, name: editName.trim() },
                              { onSuccess: () => setEditingId(null) },
                            );
                          }
                          if (e.key === "Escape") setEditingId(null);
                        }}
                        autoFocus
                      />
                      <Button
                        size="sm"
                        onClick={() => {
                          if (editName.trim()) {
                            renameProfile.mutate(
                              { id: profile.id, name: editName.trim() },
                              { onSuccess: () => setEditingId(null) },
                            );
                          }
                        }}
                        disabled={!editName.trim() || renameProfile.isPending}
                      >
                        {t("btn.save")}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setEditingId(null)}>
                        {t("btn.cancel")}
                      </Button>
                    </div>
                  ) : (
                    <>
                      <h3 className="text-[0.95rem] font-semibold">
                        {profile.name}
                        {profile.isDefault && (
                          <span className="border-border bg-background text-muted-foreground ml-1.5 inline-flex items-center rounded-full border px-2 py-px text-[0.7rem]">
                            {t("profiles.default")}
                          </span>
                        )}
                      </h3>
                      <span className="text-muted-foreground text-sm">
                        {t("profiles.connections", { count: profile.connectionCount })}
                      </span>
                    </>
                  )}
                </div>
              </div>
              {editingId !== profile.id && (
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setEditingId(profile.id);
                      setEditName(profile.name);
                    }}
                  >
                    {t("profiles.rename")}
                  </Button>
                  {!profile.isDefault && (
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => setConfirmState({ label: profile.name, id: profile.id })}
                      disabled={deleteProfile.isPending}
                    >
                      {t("profiles.delete")}
                    </Button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <ConfirmModal
        open={!!confirmState}
        onClose={() => setConfirmState(null)}
        title={t("btn.confirm", { ns: "common" })}
        description={confirmState ? t("profiles.deleteConfirm", { name: confirmState.label }) : ""}
        isPending={deleteProfile.isPending}
        onConfirm={() => {
          if (confirmState) {
            deleteProfile.mutate(confirmState.id, {
              onSuccess: () => setConfirmState(null),
            });
          }
        }}
      />
    </>
  );
}
