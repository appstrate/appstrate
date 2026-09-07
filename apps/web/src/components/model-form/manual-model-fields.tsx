// SPDX-License-Identifier: Apache-2.0

/**
 * Naming a model by hand: its id, the row's name, and the capabilities the
 * operator may answer for.
 *
 * The same three fields whatever the provider — an edit always uses them, and a
 * create falls back to them wherever a listing has nothing to offer or the
 * operator would rather type the id. Nothing here knows which of the two it is.
 */

import type { ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import type { UseFormRegisterReturn } from "react-hook-form";
import { cn } from "@appstrate/ui/cn";
import { Input } from "@appstrate/ui/components/input";
import { Label } from "@appstrate/ui/components/label";
import { CapabilitiesSection } from "./capabilities-section";

function TextField({
  id,
  label,
  fieldProps,
  error,
  placeholder,
}: {
  id: string;
  label: string;
  fieldProps: UseFormRegisterReturn;
  error?: string;
  placeholder?: string;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="text"
        {...fieldProps}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        className={cn(error && "border-destructive")}
      />
      {error && <div className="text-destructive text-sm">{error}</div>}
    </div>
  );
}

export function ManualModelFields({
  idPrefix,
  modelIdProps,
  modelIdError,
  labelProps,
  labelError,
  /** Absent on an edit: the row is named, so nothing is derived from the id. */
  labelPlaceholder,
  capabilities,
}: {
  idPrefix: string;
  modelIdProps: UseFormRegisterReturn;
  modelIdError?: string;
  labelProps: UseFormRegisterReturn;
  labelError?: string;
  labelPlaceholder?: string;
  capabilities: ComponentProps<typeof CapabilitiesSection>;
}) {
  const { t } = useTranslation(["settings", "common"]);

  return (
    <>
      <TextField
        id={`${idPrefix}-modelId`}
        label={t("models.form.modelId")}
        fieldProps={modelIdProps}
        error={modelIdError}
        placeholder="ex: claude-sonnet-4-5-20250929"
      />
      <TextField
        id={`${idPrefix}-label`}
        label={t("models.form.label")}
        fieldProps={labelProps}
        error={labelError}
        placeholder={labelPlaceholder}
      />
      <CapabilitiesSection {...capabilities} />
    </>
  );
}
