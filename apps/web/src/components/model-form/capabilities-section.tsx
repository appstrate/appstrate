// SPDX-License-Identifier: Apache-2.0

/**
 * "Capabilities" sub-section of the model form modal — limits and modalities.
 * It renders in every manual arrangement, a catalogued row's edit form
 * included: what a row follows is a question about that row, not about which
 * provider it names.
 *
 * One toggle owns the whole section, because the alternative to filling it in
 * is not "leave the fields blank" but a documented fallback chain the operator
 * should be able to read: the server resolves row override → vendored catalog
 * by model id → nothing, and the runtime replaces that nothing with fixed
 * defaults (`runtime-pi/env.ts`: 128000 context / 16384 output tokens;
 * `apps/api/src/services/run-launcher/pi.ts`: text-only input, no reasoning).
 * Off, the sentence states that chain; on, the operator answers it themselves
 * and every field ships — a visible unticked box then means `false`, not
 * "undefined".
 *
 * The host passes `register` props for the numeric text fields plus
 * imperative setters for the booleans so this component stays unaware
 * of the parent's RHF field-name generic.
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
