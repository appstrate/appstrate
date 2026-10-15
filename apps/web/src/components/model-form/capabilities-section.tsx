// SPDX-License-Identifier: Apache-2.0

/**
 * Limits and modalities, behind one toggle. Off, a sentence states the
 * fallback chain (row override → catalog → runtime defaults: 128000 context /
 * 16384 output tokens, text-only, no reasoning); on, every field ships and an
 * unticked box means `false`. The host passes `register` props for the numeric
 * fields and setters for the booleans, so this stays unaware of its RHF generic.
 */

import { useTranslation } from "react-i18next";
import { CheckboxField } from "@appstrate/ui/components/checkbox";
import { FormItem } from "@appstrate/ui/components/field";
import { Input } from "@appstrate/ui/components/input";
import { Label } from "@appstrate/ui/components/label";
import type { UseFormRegisterReturn } from "react-hook-form";

interface CapabilitiesSectionProps {
  explicit: boolean;
  contextWindowProps: UseFormRegisterReturn;
  maxTokensProps: UseFormRegisterReturn;
  inputText: boolean;
  inputImage: boolean;
  reasoning: boolean;
  onExplicitChange: (v: boolean) => void;
  onInputTextChange: (v: boolean) => void;
  onInputImageChange: (v: boolean) => void;
  onReasoningChange: (v: boolean) => void;
}

export function CapabilitiesSection({
  explicit,
  contextWindowProps,
  maxTokensProps,
  inputText,
  inputImage,
  reasoning,
  onExplicitChange,
  onInputTextChange,
  onInputImageChange,
  onReasoningChange,
}: CapabilitiesSectionProps) {
  const { t } = useTranslation(["settings", "common"]);

  return (
    <div className="mt-2 space-y-4 border-t pt-4">
      <CheckboxField
        id="mdl-capabilities-explicit"
        label={t("models.form.capabilitiesExplicit")}
        checked={explicit}
        onCheckedChange={(checked) => onExplicitChange(Boolean(checked))}
      />

      {explicit ? (
        <>
          <div className="space-y-2">
            <Label className="text-muted-foreground text-sm font-medium">
              {t("models.form.capabilitiesLimits")}
            </Label>
            <div className="grid grid-cols-2 gap-4">
              <FormItem id="mdl-ctx" label={t("models.form.contextWindow")}>
                <Input type="number" {...contextWindowProps} placeholder="128000" />
              </FormItem>
              <FormItem id="mdl-maxtok" label={t("models.form.maxTokens")}>
                <Input type="number" {...maxTokensProps} placeholder="16384" />
              </FormItem>
            </div>
          </div>

          <div className="space-y-2">
            <Label className="text-muted-foreground text-sm font-medium">
              {t("models.form.capabilitiesAccepts")}
            </Label>
            <div className="flex flex-wrap gap-4">
              <CheckboxField
                id="mdl-input-text"
                label={t("models.form.inputText")}
                checked={inputText}
                onCheckedChange={(checked) => onInputTextChange(Boolean(checked))}
              />
              <CheckboxField
                id="mdl-input-image"
                label={t("models.form.inputImage")}
                checked={inputImage}
                onCheckedChange={(checked) => onInputImageChange(Boolean(checked))}
              />
              <CheckboxField
                id="mdl-reasoning"
                label={t("models.form.reasoning")}
                checked={reasoning}
                onCheckedChange={(checked) => onReasoningChange(Boolean(checked))}
              />
            </div>
          </div>
        </>
      ) : (
        <div className="text-muted-foreground text-sm">{t("models.form.capabilitiesAuto")}</div>
      )}
    </div>
  );
}
