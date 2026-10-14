// SPDX-License-Identifier: Apache-2.0

/**
 * Naming a model by hand: its id, the row's name, and the capabilities section. Rendered inside a
 * `FormProvider` whose form holds the `ManualRowFields`: the capabilities are wired to it here,
 * the id and the name come registered with the host's own rules.
 */

import { useTranslation } from "react-i18next";
import { useFormContext, useWatch, type UseFormRegisterReturn } from "react-hook-form";
import { Input } from "@appstrate/ui/components/input";
import { FormItem } from "@appstrate/ui/components/field";
import type { ManualRowFields } from "@/lib/model-form-payload";
import { CapabilitiesSection } from "./capabilities-section";

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
      <FormItem id={`${idPrefix}-modelId`} label={t("models.form.modelId")} error={modelIdError}>
        <Input type="text" {...modelIdProps} placeholder={t("models.form.modelIdPlaceholder")} />
      </FormItem>
      <FormItem id={`${idPrefix}-label`} label={t("models.form.label")} error={labelError}>
        <Input type="text" {...labelProps} placeholder={labelPlaceholder} />
      </FormItem>
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
