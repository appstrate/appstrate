// SPDX-License-Identifier: Apache-2.0

/**
 * "Capabilities" sub-section of the model form modal — input modalities,
 * context window, max tokens, and reasoning flag. Only rendered for
 * custom-provider or custom-model paths; preset and OpenRouter selections
 * already auto-fill these values from their source of truth.
 *
 * The host passes `register` props for the numeric text fields plus
 * imperative setters for the booleans so this component stays unaware
 * of the parent's RHF field-name generic.
 */

import { useTranslation } from "react-i18next";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { UseFormRegisterReturn } from "react-hook-form";

interface CapabilitiesSectionProps {
  contextWindowProps: UseFormRegisterReturn;
  maxTokensProps: UseFormRegisterReturn;
  inputText: boolean;
  inputImage: boolean;
  reasoning: boolean;
  onInputTextChange: (v: boolean) => void;
  onInputImageChange: (v: boolean) => void;
  onReasoningChange: (v: boolean) => void;
}

export function CapabilitiesSection({
  contextWindowProps,
  maxTokensProps,
  inputText,
  inputImage,
  reasoning,
  onInputTextChange,
  onInputImageChange,
  onReasoningChange,
}: CapabilitiesSectionProps) {
  const { t } = useTranslation(["settings", "common"]);

  return (
    <div className="mt-2 space-y-4 border-t pt-4">
      <Label className="text-muted-foreground text-sm font-medium">
        {t("models.form.capabilities")}
      </Label>
      <div className="space-y-2">
        <Label>{t("models.form.input")}</Label>
        <div className="flex gap-4">
          <div className="flex items-center gap-2">
            <Checkbox
              id="mdl-input-text"
              checked={inputText}
              onCheckedChange={(checked) => onInputTextChange(Boolean(checked))}
            />
            <Label htmlFor="mdl-input-text" className="cursor-pointer font-normal">
              {t("models.form.inputText")}
            </Label>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id="mdl-input-image"
              checked={inputImage}
              onCheckedChange={(checked) => onInputImageChange(Boolean(checked))}
            />
            <Label htmlFor="mdl-input-image" className="cursor-pointer font-normal">
              {t("models.form.inputImage")}
            </Label>
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="mdl-ctx">{t("models.form.contextWindow")}</Label>
          <Input id="mdl-ctx" type="number" {...contextWindowProps} placeholder="200000" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="mdl-maxtok">{t("models.form.maxTokens")}</Label>
          <Input id="mdl-maxtok" type="number" {...maxTokensProps} placeholder="16384" />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox
          id="mdl-reasoning"
          checked={reasoning}
          onCheckedChange={(checked) => onReasoningChange(Boolean(checked))}
        />
        <Label htmlFor="mdl-reasoning" className="cursor-pointer font-normal">
          {t("models.form.reasoning")}
        </Label>
      </div>
      <div className="text-muted-foreground text-sm">{t("models.form.capabilitiesHint")}</div>
    </div>
  );
}
