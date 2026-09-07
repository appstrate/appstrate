// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { toast } from "sonner";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AppWindow, Plus, X } from "lucide-react";
import { useAppForm } from "../../../hooks/use-app-form";
import { usePermissions } from "../../../hooks/use-permissions";
import { ConfirmModal } from "../../../components/confirm-modal";
import { Button } from "@appstrate/ui/components/button";
import { Input } from "@appstrate/ui/components/input";
import { Alert, AlertDescription } from "@appstrate/ui/components/alert";
import { Field, FieldDescription, FieldGroup } from "@appstrate/ui/components/field";
import { Label } from "@appstrate/ui/components/label";
import { RadioGroup, RadioGroupItem } from "@appstrate/ui/components/radio-group";
import { SPACE_VISIBILITIES } from "@appstrate/core/permissions";
import { RoleCatalogState } from "../../../components/role-catalog-state";
import { SpaceRoleSelect } from "../../../components/space-role-select";
import { useSpaceRoleOptions, type SpaceRolePreset } from "../../../hooks/use-roles";
import type { components } from "../../../api/client";
import { useSpace, useUpdateSpace, useDeleteSpace } from "../../../hooks/use-spaces";
import { useCurrentSpaceId } from "../../../hooks/use-current-space";
import { LoadingState, ErrorState, EmptyState } from "../../../components/page-states";
import { Spinner } from "../../../components/spinner";
import { getErrorMessage } from "@appstrate/core/errors";

type SpaceObject = components["schemas"]["SpaceObject"];
type SpaceVisibility = SpaceObject["visibility"];

interface SettingsFormData {
  name: string;
}

export function OrgSettingsSpaceGeneralPage() {
  const { t } = useTranslation(["settings", "common"]);
  const spaceId = useCurrentSpaceId();
  const { data: space, isLoading, error } = useSpace(spaceId ?? "");

  if (!spaceId) return <EmptyState message={t("spaces.noSpaceSelected")} icon={AppWindow} />;
  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={getErrorMessage(error)} />;
  if (!space) return <ErrorState />;

  return <GeneralForm key={spaceId} spaceId={spaceId} space={space} />;
}

function GeneralForm({ spaceId, space }: { spaceId: string; space: SpaceObject }) {
  const { t } = useTranslation(["settings", "common"]);
  const { can } = usePermissions();
  const navigate = useNavigate();
  const {
    roles,
    rolesKnown,
    isLoading: rolesLoading,
    error: rolesError,
    refetch: refetchRoles,
  } = useSpaceRoleOptions(spaceId);
  const presetOptions = (roles ?? [])
    .filter((role) => role.kind === "preset")
    .map((role) => ({ value: role.key, label: t(`roles.preset.${role.key}`) }));
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
  const defaultRoleLocked =
    rolesLoading || !!rolesError || presetOptions.length === 0 || updateMutation.isPending;

  const { register, handleSubmit, showError } = useAppForm<SettingsFormData>({
    values: { name: space.name },
  });

  const onSubmit = (data: SettingsFormData) => {
    updateMutation.mutate(
      {
        params: { path: { id: spaceId } },
        body: {
          name: data.name.trim(),
          settings: { allowedRedirectDomains: activeDomains },
          visibility,
          default_role: defaultRole,
        },
      },
      { onSuccess: () => toast.success(t("spaces.saved")) },
    );
  };

  return (
    <>
      <form onSubmit={handleSubmit(onSubmit)} className="max-w-xl">
        <FieldGroup>
          <Field data-invalid={!!showError("name")} data-disabled={updateMutation.isPending}>
            <Label htmlFor="space-name">{t("spaces.nameLabel")}</Label>
            <Input
              id="space-name"
              type="text"
              {...register("name", { required: true })}
              aria-invalid={!!showError("name")}
              placeholder={t("spaces.namePlaceholder")}
              disabled={updateMutation.isPending}
            />
            {showError("name") && (
              <FieldDescription role="alert">
                {t("validation.required", { ns: "common" })}
              </FieldDescription>
            )}
          </Field>

          <fieldset className="flex flex-col gap-3" disabled={updateMutation.isPending}>
            <legend className="mb-2 text-sm font-medium">{t("spaces.visibilityLabel")}</legend>
            <FieldDescription>{t("spaces.visibilityHint")}</FieldDescription>
            <RadioGroup
              value={visibility}
              onValueChange={(value) => setEditedVisibility(value as SpaceVisibility)}
              disabled={space.isDefault || updateMutation.isPending}
              aria-label={t("spaces.visibilityLabel")}
            >
              {SPACE_VISIBILITIES.map((value) => (
                <Field key={value} orientation="horizontal" className="items-start">
                  <RadioGroupItem
                    value={value}
                    id={`space-visibility-${value}`}
                    className="mt-1 shrink-0"
                  />
                  <Label
                    htmlFor={`space-visibility-${value}`}
                    className="flex min-w-0 flex-col items-start gap-1"
                  >
                    <span>{t(`spaces.visibility.${value}`)}</span>
                    <span className="text-muted-foreground text-sm leading-relaxed font-normal">
                      {t(`spaces.visibilityDesc.${value}`)}
                    </span>
                  </Label>
                </Field>
              ))}
            </RadioGroup>
            <FieldDescription>{t("spaces.adminAccessHint")}</FieldDescription>
            {space.isDefault && (
              <FieldDescription>{t("spaces.visibilityDefaultLocked")}</FieldDescription>
            )}
          </fieldset>

          {visibility === "open" && (
            <Field data-disabled={defaultRoleLocked}>
              <Label htmlFor="space-default-role">{t("spaces.defaultRoleLabel")}</Label>
              <FieldDescription>{t("spaces.defaultRoleHint")}</FieldDescription>
              <SpaceRoleSelect
                id="space-default-role"
                className="w-full sm:w-[240px]"
                value={defaultRole}
                options={presetOptions}
                fallbackLabel={t(`roles.preset.${defaultRole}`)}
                disabled={defaultRoleLocked}
                onValueChange={(value) => setEditedDefaultRole(value as SpaceRolePreset)}
              />
              <RoleCatalogState
                isLoading={rolesLoading}
                rolesKnown={rolesKnown}
                error={rolesError}
                refetch={() => void refetchRoles()}
                emptyMessage={presetOptions.length === 0 ? t("spaces.noAssignablePresets") : null}
              />
              <FieldDescription>{t(`roles.presetDesc.${defaultRole}`)}</FieldDescription>
              <FieldDescription>{t("spaces.defaultRoleImpact")}</FieldDescription>
            </Field>
          )}

          <Field data-disabled={updateMutation.isPending}>
            <Label>{t("spaces.redirectDomains")}</Label>
            <FieldDescription>{t("spaces.redirectDomainsHint")}</FieldDescription>
            <div className="flex flex-col gap-2">
              {activeDomains.map((domain, index) => (
                <div key={index} className="flex items-center gap-2">
                  <Input
                    type="text"
                    value={domain}
                    disabled={updateMutation.isPending}
                    aria-label={t("spaces.domainAriaLabel", { index: index + 1 })}
                    onChange={(event) =>
                      setEditedDomains((previous) =>
                        (previous ?? domains).map((item, i) =>
                          i === index ? event.target.value : item,
                        ),
                      )
                    }
                    placeholder="example.com"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={updateMutation.isPending}
                    aria-label={t("spaces.removeDomain")}
                    onClick={() =>
                      setEditedDomains((previous) =>
                        (previous ?? domains).filter((_, i) => i !== index),
                      )
                    }
                  >
                    <X />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="self-start"
                disabled={updateMutation.isPending}
                onClick={() => setEditedDomains((previous) => [...(previous ?? domains), ""])}
              >
                <Plus data-icon="inline-start" />
                {t("spaces.addDomain")}
              </Button>
            </div>
          </Field>

          {updateMutation.error && (
            <Alert variant="destructive">
              <AlertDescription>{getErrorMessage(updateMutation.error)}</AlertDescription>
            </Alert>
          )}
          <Button type="submit" className="self-start" disabled={updateMutation.isPending}>
            {updateMutation.isPending ? <Spinner /> : t("btn.save")}
          </Button>
        </FieldGroup>
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
            <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
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
              onError: (error) => toast.error(getErrorMessage(error)),
            },
          );
        }}
      />
    </>
  );
}
