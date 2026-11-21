// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Label } from "@appstrate/ui/components/label";
import { Switch } from "@appstrate/ui/components/switch";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { DisabledReasonTooltip } from "../disabled-reason-tooltip";
import { SettingRow } from "./setting-row";
import { SaveFeedback } from "./save-feedback";
import { useOrg } from "../../hooks/use-org";
import { useOrgSettings, useUpdateOrgSettings } from "../../hooks/use-org-settings";
import { usePermissions } from "../../hooks/use-permissions";
import { fieldWriteState } from "../../lib/field-write-state";
import {
  toggleBody,
  type OrgToggleField,
  type ToggleValues,
} from "../../lib/org-setting-toggle-body";

/**
 * An organization setting as a self-saving switch row (`org:settings`): a boolean, or a two-valued
 * setting when `values` names what ON and OFF store. A skeleton stands in until the settings load,
 * so a click can never send a value read off a default; a refusal is said once, by the global
 * mutation toast.
 */
export function OrgSettingToggle({
  id,
  label,
  description,
  field,
  values,
  onSuccess,
}: {
  id: string;
  label: ReactNode;
  description: ReactNode;
  field: OrgToggleField;
  values?: ToggleValues;
  onSuccess?: () => void;
}) {
  const { t } = useTranslation("settings");
  const { currentOrg } = useOrg();
  const { can } = usePermissions();
  const { data: orgSettings, isLoading } = useOrgSettings();
  const update = useUpdateOrgSettings();
  if (!currentOrg) return null;
  const mayWrite = can("org:settings");

  return (
    <SettingRow
      variant="toggle"
      label={
        <Label htmlFor={id} className="cursor-pointer">
          {label}
        </Label>
      }
      description={description}
      status={<SaveFeedback {...fieldWriteState(update, field)} />}
    >
      {!isLoading ? (
        <DisabledReasonTooltip reason={mayWrite ? null : t("orgSettings.cannotChange")}>
          <Switch
            id={id}
            checked={values ? orgSettings?.[field] === values.on : orgSettings?.[field] === true}
            disabled={!mayWrite || !orgSettings || update.isPending}
            onCheckedChange={(checked) =>
              update.mutate(
                {
                  params: { path: { orgId: currentOrg.id } },
                  body: toggleBody(field, checked === true, values),
                },
                { onSuccess },
              )
            }
          />
        </DisabledReasonTooltip>
      ) : (
        <Skeleton className="h-6 w-11 rounded-full" />
      )}
    </SettingRow>
  );
}
