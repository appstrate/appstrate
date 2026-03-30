import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "../components/page-header";
import { LoadingState, ErrorState, EmptyState } from "../components/page-states";
import { Modal } from "../components/modal";
import {
  useOrgProfiles,
  useRenameOrgProfile,
  useDeleteOrgProfile,
  useOrgProfileFlows,
} from "../hooks/use-connection-profiles";
import { useProviders } from "../hooks/use-providers";
import { useFlows } from "../hooks/use-packages";
import { useAllSchedules } from "../hooks/use-schedules";
import { ProviderConnectionCard } from "../components/provider-connection-card";
import { PackageCard } from "../components/package-card";
import { ScheduleCard } from "../components/schedule-card";
import { Calendar, Pencil, Trash2, FolderOpen, Workflow } from "lucide-react";

export function OrgProfileDetailPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const { data: orgProfiles, isLoading: profilesLoading } = useOrgProfiles();
  const { data: providers } = useProviders();
  const { data: flows } = useFlows();
  const { data: allSchedules } = useAllSchedules();
  const { data: linkedFlowRefs } = useOrgProfileFlows(id);

  const renameMutation = useRenameOrgProfile();
  const deleteMutation = useDeleteOrgProfile();

  const [renameOpen, setRenameOpen] = useState(false);
  const [renameName, setRenameName] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);

  if (profilesLoading) return <LoadingState />;

  const profile = orgProfiles?.find((p) => p.id === id);
  if (!profile) return <ErrorState message={t("orgProfiles.notFound")} />;

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
      onSuccess: () => navigate("/org-settings#profiles"),
    });
  };

  return (
    <>
      <PageHeader
        title={profile.name}
        breadcrumbs={[
          { label: t("nav.orgSection", { ns: "common" }), href: "/" },
          { label: t("orgSettings.pageTitle"), href: "/org-settings#profiles" },
          { label: profile.name },
        ]}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={openRename}>
              <Pencil className="size-3.5 mr-1.5" />
              {t("orgProfiles.rename")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleteOpen(true)}
              disabled={deleteMutation.isPending}
            >
              <Trash2 className="size-3.5 mr-1.5" />
              {t("orgProfiles.deleteBtn")}
            </Button>
          </>
        }
      />

      {/* ─── Providers ──────────────────────────────────── */}
      <section className="space-y-3 mb-8">
        <h3 className="text-sm font-medium text-muted-foreground">{t("orgProfiles.bindings")}</h3>

        {enabledProviders.length === 0 ? (
          <EmptyState message={t("orgProfiles.noBindings")} icon={FolderOpen} compact />
        ) : (
          <div className="space-y-2">
            {enabledProviders.map((provider) => (
              <ProviderConnectionCard
                key={provider.id}
                providerId={provider.id}
                orgProfileId={id}
                orgProfileName={profile.name}
              />
            ))}
          </div>
        )}
      </section>

      {/* ─── Flows liés ───────────────────────────────────── */}
      <section className="space-y-3 mb-8">
        <h3 className="text-sm font-medium text-muted-foreground">
          {t("orgProfiles.linkedFlows")}
        </h3>

        {(() => {
          const linkedFlowIds = new Set(linkedFlowRefs?.map((f) => f.id) ?? []);
          const linkedFlowItems = (flows ?? []).filter((f) => linkedFlowIds.has(f.id));
          return linkedFlowItems.length === 0 ? (
            <EmptyState message={t("orgProfiles.noFlows")} icon={Workflow} compact />
          ) : (
            <div className="space-y-2">
              {linkedFlowItems.map((flow) => (
                <PackageCard
                  key={flow.id}
                  id={flow.id}
                  displayName={flow.displayName}
                  description={flow.description}
                  type="flow"
                  source={flow.source}
                  runningExecutions={flow.runningExecutions}
                  keywords={flow.keywords}
                  providerIds={flow.dependencies?.providers}
                />
              ))}
            </div>
          );
        })()}
      </section>

      {/* ─── Schedules liés ──────────────────────────────── */}
      <section className="space-y-3">
        <h3 className="text-sm font-medium text-muted-foreground">
          {t("orgProfiles.linkedSchedules")}
        </h3>

        {relatedSchedules.length === 0 ? (
          <EmptyState message={t("orgProfiles.noSchedules")} icon={Calendar} compact />
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
        title={t("orgProfiles.renameTitle")}
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
          placeholder={t("orgProfiles.namePlaceholder")}
          onKeyDown={(e) => e.key === "Enter" && handleRename()}
          autoFocus
        />
      </Modal>

      {/* Delete confirmation modal */}
      <Modal
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title={t("orgProfiles.deleteTitle")}
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
              {t("orgProfiles.deleteBtn")}
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted-foreground">
          {t("orgProfiles.deleteConfirm", { name: profile.name })}
        </p>
      </Modal>
    </>
  );
}
