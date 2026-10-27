// SPDX-License-Identifier: Apache-2.0

import type { ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import { ORG_ROLES } from "@appstrate/core/permissions";
import type { OrgRole } from "@appstrate/shared-types";
import { OptionSelect } from "@/components/app-ui/option-select";
import { roleI18nKey } from "../hooks/use-permissions";

/** The `roles` an actor may pick, in the order every org-role list uses (widest reach first). */
export function OrgRoleSelect({
  roles,
  value,
  onValueChange,
  ...props
}: {
  roles: readonly OrgRole[];
  value: OrgRole;
  onValueChange: (role: OrgRole) => void;
} & Omit<ComponentProps<typeof OptionSelect>, "options" | "value" | "onValueChange">) {
  const { t } = useTranslation("settings");
  return (
    <OptionSelect
      {...props}
      value={value}
      onValueChange={(role) => onValueChange(role as OrgRole)}
      options={ORG_ROLES.filter((role) => roles.includes(role)).map((role) => ({
        value: role,
        label: t(roleI18nKey(role)),
      }))}
    />
  );
}
