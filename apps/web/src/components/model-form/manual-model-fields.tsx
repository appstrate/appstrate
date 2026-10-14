// SPDX-License-Identifier: Apache-2.0

/**
 * Naming a model by hand: its id, the row's name, and the capabilities section. Rendered inside a
 * `FormProvider` whose form holds the `ManualRowFields`: the capabilities are wired to it here,
 * the id and the name come registered with the host's own rules.
 */

import { useTranslation } from "react-i18next";
import { useFormContext, useWatch, type UseFormRegisterReturn } from "react-hook-form";
import { cn } from "@appstrate/ui/cn";
import { Input } from "@appstrate/ui/components/input";
import { Label } from "@appstrate/ui/components/label";
import type { ManualRowFields } from "@/lib/model-form-payload";
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
}: {
  idPrefix: string;
  modelIdProps: UseFormRegisterReturn;
  modelIdError?: string;
  labelProps: UseFormRegisterReturn;
  labelError?: string;
  labelPlaceholder?: string;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const { register, control, setValue } = useFormContext<ManualRowFields>();
  const [explicit, inputText, inputImage, reasoning] = useWatch({
    control,
    name: ["capabilitiesExplicit", "inputText", "inputImage", "reasoning"],
  });

  return (
    <>
      <TextField
        id={`${idPrefix}-modelId`}
        label={t("models.form.modelId")}
        fieldProps={modelIdProps}
        error={modelIdError}
        placeholder={t("models.form.modelIdPlaceholder")}
      />
      <TextField
        id={`${idPrefix}-label`}
        label={t("models.form.label")}
        fieldProps={labelProps}
        error={labelError}
        placeholder={labelPlaceholder}
      />
      <CapabilitiesSection
        explicit={explicit}
        contextWindowProps={register("contextWindow")}
        maxTokensProps={register("maxTokens")}
        inputText={inputText}
        inputImage={inputImage}
        reasoning={reasoning}
        onExplicitChange={(v) => setValue("capabilitiesExplicit", v)}
        onInputTextChange={(v) => setValue("inputText", v)}
        onInputImageChange={(v) => setValue("inputImage", v)}
        onReasoningChange={(v) => setValue("reasoning", v)}
      />
    </>
  );
}
