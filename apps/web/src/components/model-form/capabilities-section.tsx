// SPDX-License-Identifier: Apache-2.0

/**
 * Limits and modalities, behind one toggle. Off, a sentence states the
 * fallback chain (row override → catalog → runtime defaults: 128000 context /
 * 16384 output tokens, text-only, no reasoning); on, every field ships and an
 * unticked box means `false`. The host passes `register` props for the numeric
 * fields and setters for the booleans, so this stays unaware of its RHF generic.
 */

import { useTranslation } from "react-i18next";
import { Checkbox } from "@appstrate/ui/components/checkbox";
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
      <div className="flex items-center gap-2">
        <Checkbox
          id="mdl-capabilities-explicit"
          checked={explicit}
          onCheckedChange={(checked) => onExplicitChange(Boolean(checked))}
        />
        <Label htmlFor="mdl-capabilities-explicit" className="cursor-pointer font-normal">
          {t("models.form.capabilitiesExplicit")}
        </Label>
      </div>

      {explicit ? (
        <>
          <div className="space-y-2">
            <Label className="text-muted-foreground text-sm font-medium">
              {t("models.form.capabilitiesLimits")}
            </Label>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="mdl-ctx">{t("models.form.contextWindow")}</Label>
                <Input id="mdl-ctx" type="number" {...contextWindowProps} placeholder="128000" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="mdl-maxtok">{t("models.form.maxTokens")}</Label>
                <Input id="mdl-maxtok" type="number" {...maxTokensProps} placeholder="16384" />
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <Label className="text-muted-foreground text-sm font-medium">
              {t("models.form.capabilitiesAccepts")}
            </Label>
            <div className="flex flex-wrap gap-4">
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
            </div>
          </div>
        </>
      ) : (
        <div className="text-muted-foreground text-sm">{t("models.form.capabilitiesAuto")}</div>
      )}
    </div>
  );
}
