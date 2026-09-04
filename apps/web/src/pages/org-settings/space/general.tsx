// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AppWindow, Plus, X } from "lucide-react";
import { useAppForm } from "../../../hooks/use-app-form";
import { usePermissions } from "../../../hooks/use-permissions";
import { ConfirmModal } from "../../../components/confirm-modal";
import { Button } from "@appstrate/ui/components/button";
import { Input } from "@appstrate/ui/components/input";
import { Label } from "@appstrate/ui/components/label";
import { RadioGroup, RadioGroupItem } from "@appstrate/ui/components/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@appstrate/ui/components/select";
import { SPACE_ROLE_PRESETS, type SpaceRolePreset } from "../../../hooks/use-roles";
import type { components } from "../../../api/client";
import { useSpace, useUpdateSpace, useDeleteSpace } from "../../../hooks/use-spaces";
import { useCurrentSpaceId } from "../../../hooks/use-current-space";
import { LoadingState, ErrorState, EmptyState } from "../../../components/page-states";
import { Spinner } from "../../../components/spinner";
import { getErrorMessage } from "@appstrate/core/errors";

type SpaceObject = components["schemas"]["SpaceObject"];
type SpaceVisibility = SpaceObject["visibility"];

const VISIBILITIES: readonly SpaceVisibility[] = ["open", "closed", "private"];

interface SettingsFormData {
  name: string;
}

export function OrgSettingsSpaceGeneralPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { can } = usePermissions();
  const spaceId = useCurrentSpaceId();
  const { data: space, isLoading, error } = useSpace(spaceId ?? "");

  if (!can("space-settings:write")) return null;
  if (!spaceId) return <EmptyState message={t("spaces.noSpaceSelected")} icon={AppWindow} />;
  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={getErrorMessage(error)} />;
  if (!space) return <ErrorState />;

  return <GeneralForm spaceId={spaceId} space={space} />;
}

function GeneralForm({ spaceId, space }: { spaceId: string; space: SpaceObject }) {
  const { t } = useTranslation(["settings", "common"]);
  const { can } = usePermissions();
  const navigate = useNavigate();
  const updateMutation = useUpdateSpace();
  const deleteMutation = useDeleteSpace();

  const domains = space.settings?.allowedRedirectDomains ?? [];
  const [editedDomains, setEditedDomains] = useState<string[] | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const activeDomains = editedDomains ?? domains;

  // The default space must stay `open` — the API answers 400 otherwise, and a
  // DB check backs it, so the control is disabled rather than merely warned on.
  const [editedVisibility, setEditedVisibility] = useState<SpaceVisibility | null>(null);
  const [editedDefaultRole, setEditedDefaultRole] = useState<SpaceRolePreset | null>(null);
  const visibility = editedVisibility ?? space.visibility;
  const defaultRole = editedDefaultRole ?? space.default_role;

  const { register, handleSubmit, showError } = useAppForm<SettingsFormData>({
    values: { name: space.name },
  });

  const onSubmit = (data: SettingsFormData) => {
    updateMutation.mutate({
      params: { path: { id: spaceId } },
      body: {
        name: data.name.trim(),
        settings: { allowedRedirectDomains: activeDomains },
        visibility,
        default_role: defaultRole,
      },
    });
  };

  return (
    <>
      <form onSubmit={handleSubmit(onSubmit)} className="max-w-xl space-y-6">
        <div className="space-y-2">
          <Label htmlFor="space-name">{t("spaces.nameLabel")}</Label>
          <Input
            id="space-name"
            type="text"
            {...register("name", { required: true })}
            placeholder={t("spaces.namePlaceholder")}
          />
          {showError("name") && (
            <p className="text-destructive text-sm">{t("validation.required", { ns: "common" })}</p>
          )}
        </div>

        <div className="space-y-2">
          <Label>{t("spaces.redirectDomains")}</Label>
          <p className="text-muted-foreground text-sm">{t("spaces.redirectDomainsHint")}</p>
          <div className="flex flex-col gap-2">
            {activeDomains.map((domain, index) => (
              <div key={index} className="flex items-center gap-2">
                <Input
                  type="text"
                  value={domain}
                  onChange={(e) =>
                    setEditedDomains((prev) =>
                      (prev ?? domains).map((d, i) => (i === index ? e.target.value : d)),
                    )
                  }
                  placeholder="example.com"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() =>
                    setEditedDomains((prev) => (prev ?? domains).filter((_, i) => i !== index))
                  }
                >
                  <X size={16} />
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setEditedDomains((prev) => [...(prev ?? domains), ""])}
            >
              <Plus size={14} className="mr-1.5" />
              {t("spaces.addDomain")}
            </Button>
          </div>
        </div>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{t("spaces.visibilityLabel")}</legend>
          <p className="text-muted-foreground text-sm">{t("spaces.visibilityHint")}</p>
          <RadioGroup
            value={visibility}
            onValueChange={(v) => setEditedVisibility(v as SpaceVisibility)}
            disabled={space.isDefault}
            aria-label={t("spaces.visibilityLabel")}
          >
            {VISIBILITIES.map((value) => (
              <div key={value} className="flex items-start gap-2">
                <RadioGroupItem value={value} id={`space-visibility-${value}`} className="mt-1" />
                <Label htmlFor={`space-visibility-${value}`} className="flex flex-col items-start">
                  <span>{t(`spaces.visibility.${value}`)}</span>
                  <span className="text-muted-foreground text-xs font-normal">
                    {t(`spaces.visibilityDesc.${value}`)}
                  </span>
                </Label>
              </div>
            ))}
          </RadioGroup>
          {space.isDefault && (
            <p className="text-muted-foreground text-sm">{t("spaces.visibilityDefaultLocked")}</p>
          )}
        </fieldset>

        {visibility === "open" && (
          <div className="space-y-2">
            <Label htmlFor="space-default-role">{t("spaces.defaultRoleLabel")}</Label>
            <p className="text-muted-foreground text-sm">{t("spaces.defaultRoleHint")}</p>
            <Select
              value={defaultRole}
              onValueChange={(v) => setEditedDefaultRole(v as SpaceRolePreset)}
            >
              <SelectTrigger id="space-default-role" className="w-[200px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SPACE_ROLE_PRESETS.map((preset) => (
                  <SelectItem key={preset} value={preset}>
                    {t(`roles.preset.${preset}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <Button type="submit" disabled={updateMutation.isPending}>
          {updateMutation.isPending ? <Spinner /> : t("btn.save")}
        </Button>
      </form>

      {/* Deleting a space is an ORG-level grant (`DELETE /api/spaces/:id`),
          not part of governing this one — a space admin who is an org member
          holds `space-settings:write` and still cannot delete it. */}
      {!space.isDefault && can("spaces:delete") && (
        <>
          <div className="text-muted-foreground mt-8 mb-4 text-sm font-medium">
            {t("spaces.dangerZone")}
          </div>
          <div className="border-destructive bg-card max-w-xl rounded-lg border p-5">
            <div className="flex items-center gap-3">
              <div className="flex-1">
                <h3 className="text-sm font-semibold">{t("spaces.deleteTitle")}</h3>
                <span className="text-muted-foreground text-sm">{t("spaces.deleteDesc")}</span>
              </div>
              <Button
                variant="destructive"
                disabled={deleteMutation.isPending}
                onClick={() => setConfirmOpen(true)}
              >
                {deleteMutation.isPending ? t("spaces.deleting") : t("btn.delete")}
              </Button>
            </div>
          </div>
        </>
      )}

      <ConfirmModal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={t("btn.confirm", { ns: "common" })}
        description={t("spaces.deleteConfirm", { name: space.name })}
        isPending={deleteMutation.isPending}
        onConfirm={() => {
          deleteMutation.mutate(
            { params: { path: { id: spaceId } } },
            {
              onSuccess: () => {
                setConfirmOpen(false);
                navigate("/org-settings/spaces");
              },
            },
          );
        }}
      />
    </>
  );
}
