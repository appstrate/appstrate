// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import type { OrgRole } from "@appstrate/shared-types";
import { Field } from "@appstrate/ui/components/field";
import { Label } from "@appstrate/ui/components/label";
import { RadioGroup, RadioGroupItem } from "@appstrate/ui/components/radio-group";
import { roleI18nKey } from "../hooks/use-permissions";

/**
 * Choosing an organization role, as described radio options.
 *
 * Three at most, each carrying its own description, so the choice reads as a
 * legend instead of a closed list plus one hint. Shared by the invitation form
 * and the role-preview dialog: what a role means is one answer, and two copies
 * of it drift.
 *
 * NOT used by the OAuth signup-policy form, which is a native `<select>` with
 * its own `oauthClients.signupRoleOption.*` labels and a single hint below —
 * a different control for a different question (a policy, not a person).
 *
 * `orgSettings.inviteRoleAriaLabel` is the shared legend; it keeps the name of
 * its first caller rather than costing a locale rename for cosmetics.
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
    <fieldset className="flex flex-col gap-3" disabled={disabled}>
      <legend className="mb-2 text-sm font-medium">{label}</legend>
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
            <Label
              htmlFor={`${idPrefix}-role-${option}`}
              className="flex min-w-0 flex-col items-start gap-1"
            >
              <span>{t(roleI18nKey(option))}</span>
              <span className="text-muted-foreground text-sm leading-relaxed font-normal">
                {t(`orgSettings.roleHint.${option}`)}
              </span>
            </Label>
          </Field>
        ))}
      </RadioGroup>
    </fieldset>
  );
}
