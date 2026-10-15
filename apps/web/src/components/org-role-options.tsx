// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import type { OrgRole } from "@appstrate/shared-types";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@appstrate/ui/components/field";
import { RadioGroup, RadioGroupItem } from "@appstrate/ui/components/radio-group";
import { roleI18nKey } from "../hooks/use-permissions";

/**
 * Organization role as described radio options, shared by the invitation form
 * and the role-preview dialog so what a role means has one copy. The OAuth
 * signup-policy form deliberately keeps its own `<select>` (a policy, not a person).
 */
export function OrgRoleOptions({
  options,
  value,
  onValueChange,
  disabled,
  idPrefix,
}: {
  options: readonly OrgRole[];
  value: OrgRole;
  onValueChange: (role: OrgRole) => void;
  disabled?: boolean;
  /** Namespaces the radio ids, so two of these can coexist on one page. */
  idPrefix: string;
}) {
  const { t } = useTranslation("settings");
  const label = t("orgSettings.inviteRoleAriaLabel");

  return (
    <FieldSet className="gap-3" disabled={disabled}>
      <FieldLegend variant="label" className="mb-0">
        {label}
      </FieldLegend>
      <RadioGroup
        value={value}
        disabled={disabled}
        aria-label={label}
        onValueChange={(next) => onValueChange(next as OrgRole)}
      >
        {options.map((option) => (
          <Field key={option} orientation="horizontal" className="items-start">
            <RadioGroupItem
              value={option}
              id={`${idPrefix}-role-${option}`}
              className="mt-1 shrink-0"
            />
            <FieldContent>
              <FieldLabel htmlFor={`${idPrefix}-role-${option}`} className="text-foreground">
                {t(roleI18nKey(option))}
              </FieldLabel>
              <FieldDescription>{t(`orgSettings.roleHint.${option}`)}</FieldDescription>
            </FieldContent>
          </Field>
        ))}
      </RadioGroup>
    </FieldSet>
  );
}
