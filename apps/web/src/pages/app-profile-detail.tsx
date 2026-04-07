// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "../components/page-header";
import { LoadingState, ErrorState, EmptyState } from "../components/page-states";
import { Modal } from "../components/modal";
import {
  useAppProfiles,
  useRenameAppProfile,
  useDeleteAppProfile,
  useAppProfileAgents,
} from "../hooks/use-connection-profiles";
import { useProviders } from "../hooks/use-providers";
import { useAgents } from "../hooks/use-packages";
import { useAllSchedules } from "../hooks/use-schedules";
import { ProviderConnectionCard } from "../components/provider-connection-card";
import { PackageCard } from "../components/package-card";
import { ScheduleCard } from "../components/schedule-card";
import { Calendar, Pencil, Trash2, FolderOpen, Workflow } from "lucide-react";

export function AppProfileDetailPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const { data: appProfiles, isLoading: profilesLoading } = useAppProfiles();
  const { data: providers } = useProviders();
  const { data: agents } = useAgents();
  const { data: allSchedules } = useAllSchedules();
  const { data: linkedAgentRefs } = useAppProfileAgents(id);

  const renameMutation = useRenameAppProfile();
  const deleteMutation = useDeleteAppProfile();

  const [renameOpen, setRenameOpen] = useState(false);
  const [renameName, setRenameName] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);

  if (profilesLoading) return <LoadingState />;

  const profile = appProfiles?.find((p) => p.id === id);
  if (!profile) return <ErrorState message={t("appProfiles.notFound")} />;

  const enabledProviders = (providers?.providers ?? []).filter((p) => p.enabled);

  // Schedules using this profile
  const relatedSchedules = (allSchedules ?? []).filter((s) => s.connectionProfileId === id);

  const openRename = () => {
    setRenameName(profile.name);
    setRenameOpen(true);
  };

  const handleRename = () => {
    const name = renameName.trim();
    if (!name || name === profile.name) {
      setRenameOpen(false);
      return;
    }
    renameMutation.mutate({ id: profile.id, name }, { onSuccess: () => setRenameOpen(false) });
  };

  const handleDelete = () => {
    deleteMutation.mutate(profile.id, {
      onSuccess: () => navigate("/app-settings#profiles"),
    });
  };

  return (
    <>
      <PageHeader
        title={profile.name}
        breadcrumbs={[
          { label: t("nav.orgSection", { ns: "common" }), href: "/" },
          { label: t("appSettings.tabProfiles"), href: "/app-settings#profiles" },
          { label: profile.name },
        ]}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={openRename}>
              <Pencil className="mr-1.5 size-3.5" />
              {t("appProfiles.rename")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleteOpen(true)}
              disabled={deleteMutation.isPending}
            >
              <Trash2 className="mr-1.5 size-3.5" />
              {t("appProfiles.deleteBtn")}
            </Button>
          </>
        }
      />

      {/* ─── Providers ──────────────────────────────────── */}
      <section className="mb-8 space-y-3">
        <h3 className="text-muted-foreground text-sm font-medium">{t("appProfiles.bindings")}</h3>

        {enabledProviders.length === 0 ? (
          <EmptyState message={t("appProfiles.noBindings")} icon={FolderOpen} compact />
        ) : (
          <div className="space-y-2">
            {enabledProviders.map((provider) => (
              <ProviderConnectionCard
                key={provider.id}
                providerId={provider.id}
                appProfileId={id}
                appProfileName={profile.name}
              />
            ))}
          </div>
        )}
      </section>

      {/* ─── Agents liés ──────────────────────────────────── */}
      <section className="mb-8 space-y-3">
        <h3 className="text-muted-foreground text-sm font-medium">
          {t("appProfiles.linkedAgents")}
        </h3>

        {(() => {
          const linkedAgentIds = new Set(linkedAgentRefs?.map((f) => f.id) ?? []);
          const linkedAgentItems = (agents ?? []).filter((f) => linkedAgentIds.has(f.id));
          return linkedAgentItems.length === 0 ? (
            <EmptyState message={t("appProfiles.noAgents")} icon={Workflow} compact />
          ) : (
            <div className="space-y-2">
              {linkedAgentItems.map((agent) => (
                <PackageCard
                  key={agent.id}
                  id={agent.id}
                  displayName={agent.displayName}
                  description={agent.description}
                  type="agent"
                  source={agent.source}
                  runningRuns={agent.runningRuns}
                  keywords={agent.keywords}
                  providerIds={agent.dependencies?.providers}
                />
              ))}
            </div>
          );
        })()}
      </section>

      {/* ─── Schedules liés ──────────────────────────────── */}
      <section className="space-y-3">
        <h3 className="text-muted-foreground text-sm font-medium">
          {t("appProfiles.linkedSchedules")}
        </h3>

        {relatedSchedules.length === 0 ? (
          <EmptyState message={t("appProfiles.noSchedules")} icon={Calendar} compact />
        ) : (
          <div className="space-y-2">
            {relatedSchedules.map((sched) => (
              <ScheduleCard key={sched.id} schedule={sched} />
            ))}
          </div>
        )}
      </section>

      {/* Rename modal */}
      <Modal
        open={renameOpen}
        onClose={() => setRenameOpen(false)}
        title={t("appProfiles.renameTitle")}
        actions={
          <>
            <Button variant="outline" onClick={() => setRenameOpen(false)}>
              {t("btn.cancel", { ns: "common" })}
            </Button>
            <Button
              onClick={handleRename}
              disabled={!renameName.trim() || renameMutation.isPending}
            >
              {t("btn.save", { ns: "common" })}
            </Button>
          </>
        }
      >
        <Input
          value={renameName}
          onChange={(e) => setRenameName(e.target.value)}
          placeholder={t("appProfiles.namePlaceholder")}
          onKeyDown={(e) => e.key === "Enter" && handleRename()}
          autoFocus
        />
      </Modal>

      {/* Delete confirmation modal */}
      <Modal
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title={t("appProfiles.deleteTitle")}
        actions={
          <>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              {t("btn.cancel", { ns: "common" })}
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleteMutation.isPending}
            >
              {t("appProfiles.deleteBtn")}
            </Button>
          </>
        }
      >
        <p className="text-muted-foreground text-sm">
          {t("appProfiles.deleteConfirm", { name: profile.name })}
        </p>
      </Modal>
    </>
  );
}
