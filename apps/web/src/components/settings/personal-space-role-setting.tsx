// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { SettingRow } from "./setting-row";
import { SaveFeedback } from "./save-feedback";
import { SpaceRoleSelect } from "../space-role-select";
import { ConfirmModal } from "../confirm-modal";
import { useOrg } from "../../hooks/use-org";
import {
  useOrgSettings,
  usePersonalSpaceRoleImpact,
  useUpdateOrgSettings,
} from "../../hooks/use-org-settings";
import { usePermissions } from "../../hooks/use-permissions";
import { useSpaceRoleOptions } from "../../hooks/use-roles";
import { fieldWriteState } from "../../lib/field-write-state";
import { onMutationError } from "../../lib/mutation-error";
import { invalidatePackageCaches, invalidatePaths } from "../../lib/query-keys";
import {
  orgPersonalSpaceRoleBody,
  personalSpaceRoleImpactDescription,
  pickPersonalSpaceRole,
  storedRoleToSelectValue,
  type PendingPersonalSpaceRole,
} from "../../lib/personal-space-role";
import { DisabledReasonTooltip } from "../disabled-reason-tooltip";

/**
 * The role every member holds in their own personal space: a preset or one of the org's custom
 * roles. A pick that would disable members' schedules (a role without `agents:run`) is confirmed
 * first; the select keeps showing the stored value until the write lands.
 */
export function PersonalSpaceRoleSetting() {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const { currentOrg } = useOrg();
  const { can } = usePermissions();
  const { data: orgSettings, isLoading } = useOrgSettings();
  const { options, isLoading: rolesLoading } = useSpaceRoleOptions();
  const update = useUpdateOrgSettings();
  const impactOf = usePersonalSpaceRoleImpact();
  const [checking, setChecking] = useState(false);
  const [checkFailed, setCheckFailed] = useState(false);
  const [pending, setPending] = useState<PendingPersonalSpaceRole | null>(null);
  if (!currentOrg) return null;
  const mayWrite = can("org:settings");
  const value = storedRoleToSelectValue(orgSettings?.personal_space_role);
  const written = fieldWriteState(update, "personal_space_role");

  const write = (next: string) =>
    update.mutate(
      {
        params: { path: { orgId: currentOrg.id } },
        body: orgPersonalSpaceRoleBody(next),
      },
      {
        // The role changes the permissions each space serves and the verdicts carried by package rows.
        onSuccess: () => {
          setPending(null);
          void invalidatePaths(queryClient, ["/api/spaces", "/api/spaces/{id}"]);
          invalidatePackageCaches(queryClient);
        },
      },
    );

  const pick = (next: string) => {
    setCheckFailed(false);
    setChecking(true);
    pickPersonalSpaceRole(next, { impactOf, write, askConfirmation: setPending })
      .catch((error: Error) => {
        // Nothing written: reported like a refused write, under the setting and in a toast.
        setCheckFailed(true);
        onMutationError(error);
      })
      .finally(() => setChecking(false));
  };

  return (
    <SettingRow
      label={t("orgSettings.personalSpaceRoleTitle")}
      description={t("orgSettings.personalSpaceRoleDesc")}
      details={t("orgSettings.personalSpaceRoleDetails")}
      status={<SaveFeedback {...written} error={written.error || checkFailed} />}
    >
      {(labelId) => (
        <>
          <DisabledReasonTooltip reason={mayWrite ? null : t("orgSettings.cannotChange")}>
            <SpaceRoleSelect
              id="personal-space-role"
              ariaLabelledBy={labelId}
              className="w-full sm:w-[240px]"
              value={value}
              options={options}
              fallbackLabel={t("orgSettings.personalSpaceRoleUnknown")}
              loading={isLoading || rolesLoading}
              disabled={!mayWrite || !orgSettings || update.isPending || checking}
              onValueChange={pick}
            />
          </DisabledReasonTooltip>
          <ConfirmModal
            open={pending !== null}
            onClose={() => setPending(null)}
            onConfirm={() => pending && write(pending.selectValue)}
            title={t("orgSettings.personalSpaceRoleImpactTitle")}
            description={pending ? personalSpaceRoleImpactDescription(t, pending.impact) : ""}
            confirmLabel={t("orgSettings.personalSpaceRoleImpactConfirm")}
            isPending={update.isPending}
          />
        </>
      )}
    </SettingRow>
  );
}
