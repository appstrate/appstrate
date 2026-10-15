// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { Label } from "@appstrate/ui/components/label";
import { Switch } from "@appstrate/ui/components/switch";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { SettingRow } from "./setting-row";
import { SaveFeedback } from "./save-feedback";
import { useOrg } from "../../hooks/use-org";
import { useOrgSettings, useUpdateOrgSettings } from "../../hooks/use-org-settings";
import { usePermissions } from "../../hooks/use-permissions";
import { fieldWriteState } from "../../lib/field-write-state";

type OrgToggleField =
  "personal_model_credentials" | "dashboard_sso_enabled" | "restrict_package_copy";

/**
 * A boolean organization setting as a self-saving switch row (`org:settings`). A skeleton stands
 * in until the settings load, so a click can never send a value read off a default; a refusal is
 * said once, by the global mutation toast.
 */
export function OrgSettingToggle({
  id,
  label,
  description,
  field,
  onSuccess,
}: {
  id: string;
  label: ReactNode;
  description: ReactNode;
  field: OrgToggleField;
  onSuccess?: () => void;
}) {
  const { currentOrg } = useOrg();
  const { can } = usePermissions();
  const { data: orgSettings, isLoading } = useOrgSettings();
  const update = useUpdateOrgSettings();
  if (!currentOrg) return null;

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
        <Switch
          id={id}
          checked={orgSettings?.[field] ?? false}
          disabled={!can("org:settings") || !orgSettings || update.isPending}
          onCheckedChange={(checked) =>
            update.mutate(
              {
                params: { path: { orgId: currentOrg.id } },
                body: { [field]: checked === true },
              },
              { onSuccess },
            )
          }
        />
      ) : (
        <Skeleton className="h-5 w-9 rounded-full" />
      )}
    </SettingRow>
  );
}
