// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AppWindow, Plus, X } from "lucide-react";
import { usePermissions } from "../../../hooks/use-permissions";
import { ConfirmModal } from "../../../components/confirm-modal";
import { Button } from "@appstrate/ui/components/button";
import { Input } from "@appstrate/ui/components/input";
import {
  useApplication,
  useUpdateApplication,
  useDeleteApplication,
} from "../../../hooks/use-applications";
import { useCurrentApplicationId } from "../../../hooks/use-current-application";
import { LoadingState, ErrorState, EmptyState } from "../../../components/page-states";
import { Spinner } from "../../../components/spinner";
import { SettingsGroup, SettingRow } from "../../../components/settings/setting-row";
import { InlineTextSetting } from "../../../components/settings/inline-text-setting";
import { getErrorMessage } from "@appstrate/core/errors";
import { toast } from "sonner";

export function OrgSettingsAppGeneralPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { isAdmin } = usePermissions();
  const applicationId = useCurrentApplicationId();
  const { data: application, isLoading, error } = useApplication(applicationId ?? "");

  if (!isAdmin) return null;
  if (!applicationId)
    return <EmptyState message={t("applications.noAppSelected")} icon={AppWindow} />;
  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={getErrorMessage(error)} />;
  if (!application) return <ErrorState />;

  return <GeneralForm applicationId={applicationId} application={application} />;
}

function GeneralForm({
  applicationId,
  application,
}: {
  applicationId: string;
  application: {
    name: string;
    isDefault: boolean;
    settings?: { allowedRedirectDomains?: string[] };
  };
}) {
  const { t } = useTranslation(["settings", "common"]);
  const location = useLocation();
  const navigate = useNavigate();
  const updateMutation = useUpdateApplication();
  const deleteMutation = useDeleteApplication();

  const domains = application.settings?.allowedRedirectDomains ?? [];
  const [editedDomains, setEditedDomains] = useState<string[] | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [saving, setSaving] = useState<"name" | "domains" | null>(null);
  const activeDomains = editedDomains ?? domains;

  // Each control commits on its own — "the control IS the setting". The Save
  // button that used to sit under this form was the last one in the settings
  // surfaces, and it made the workspace the one screen where a change was not
  // a change until you pressed something else.
  const save = (patch: { name?: string; domains?: string[] }, field: "name" | "domains") => {
    setSaving(field);
    updateMutation.mutate(
      {
        params: { path: { id: applicationId } },
        body: {
          name: (patch.name ?? application.name).trim(),
          settings: { allowedRedirectDomains: patch.domains ?? activeDomains },
        },
      },
      {
        onError: (error) => {
          toast.error(t("error.prefix", { message: getErrorMessage(error) }));
        },
        onSettled: () => setSaving(null),
      },
    );
  };

  const commitDomains = (next: string[]) => {
    // Empty rows are the residue of editing, not a value: a domain nobody typed
    // has no business being sent, and an empty string is not one.
    const cleaned = next.map((d) => d.trim()).filter(Boolean);
    setEditedDomains(next);
    save({ domains: cleaned }, "domains");
  };

  return (
    <>
      <SettingsGroup title={t("applications.settingsTitle")}>
        <SettingRow
          variant="field"
          label={t("applications.nameLabel")}
          status={saving === "name" && <Spinner />}
        >
          <InlineTextSetting
            value={application.name}
            disabled={updateMutation.isPending}
            aria-label={t("applications.nameLabel")}
            placeholder={t("applications.namePlaceholder")}
            onCommit={(name) => save({ name }, "name")}
          />
        </SettingRow>

        <SettingRow
          variant="field"
          label={t("applications.redirectDomains")}
          description={t("applications.redirectDomainsHint")}
          status={saving === "domains" && <Spinner />}
        >
          <div className="flex w-full flex-col gap-2">
            {activeDomains.map((domain, index) => (
              <div key={index} className="flex w-full items-center gap-2">
                <Input
                  type="text"
                  value={domain}
                  disabled={updateMutation.isPending}
                  className="min-w-0 flex-1"
                  onChange={(e) =>
                    setEditedDomains((prev) =>
                      (prev ?? domains).map((d, i) => (i === index ? e.target.value : d)),
                    )
                  }
                  // Commits when you leave the field, like every other setting
                  // here; Enter is the same answer for a single-line input.
                  onBlur={() => commitDomains(activeDomains)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                  }}
                  placeholder="example.com"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={updateMutation.isPending}
                  aria-label={t("btn.delete", { ns: "common" })}
                  onClick={() => commitDomains(activeDomains.filter((_, i) => i !== index))}
                >
                  <X size={16} />
                </Button>
              </div>
            ))}
            {/* Adding one does not save: an empty row is not a domain. It
                commits when the field it opened is filled and left. */}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={updateMutation.isPending}
              className="self-start"
              onClick={() => setEditedDomains([...(activeDomains ?? []), ""])}
            >
              <Plus size={14} className="mr-1.5" />
              {t("applications.addDomain")}
            </Button>
          </div>
        </SettingRow>
      </SettingsGroup>

      {/* The danger zone is a settings group like any other. Its exception is
          the CONTROL — a button that opens a confirm — which is what the row
          pattern says a destructive setting looks like, rather than a red-bordered
          card that reads as a different kind of screen. */}
      {!application.isDefault && (
        <SettingsGroup title={t("applications.dangerZone")}>
          <SettingRow
            variant="action"
            label={t("applications.deleteTitle")}
            description={t("applications.deleteDesc")}
          >
            <Button
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={() => setConfirmOpen(true)}
            >
              {deleteMutation.isPending ? t("applications.deleting") : t("btn.delete")}
            </Button>
          </SettingRow>
        </SettingsGroup>
      )}

      <ConfirmModal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={t("btn.confirm", { ns: "common" })}
        description={t("applications.deleteConfirm", { name: application.name })}
        isPending={deleteMutation.isPending}
        onConfirm={() => {
          deleteMutation.mutate(
            { params: { path: { id: applicationId } } },
            {
              onSuccess: () => {
                setConfirmOpen(false);
                navigate("/org-settings/applications", { state: location.state });
              },
            },
          );
        }}
      />
    </>
  );
}
