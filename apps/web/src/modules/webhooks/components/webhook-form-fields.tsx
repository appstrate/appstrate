// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Label } from "@appstrate/ui/components/label";
import { CheckboxField } from "@/components/app-ui/checkbox-field";
import { RadioGroup, RadioGroupItem } from "@appstrate/ui/components/radio-group";
import { WEBHOOK_EVENTS } from "../hooks/use-webhooks";

interface WebhookFormFieldsProps {
  selectedEvents: string[];
  onToggleEvent: (event: string) => void;
  payloadMode: "full" | "summary";
  onPayloadModeChange: (mode: "full" | "summary") => void;
  idPrefix?: string;
}

export function WebhookFormFields({
  selectedEvents,
  onToggleEvent,
  payloadMode,
  onPayloadModeChange,
  idPrefix = "",
}: WebhookFormFieldsProps) {
  const { t } = useTranslation("settings");

  return (
    <>
      <div className="flex flex-col gap-2">
        <Label className="mb-0">{t("webhooks.eventsLabel")}</Label>
        <div className="flex flex-col gap-2">
          {WEBHOOK_EVENTS.map((event) => (
            <CheckboxField
              key={event}
              id={`${idPrefix}event-${event}`}
              checked={selectedEvents.includes(event)}
              onCheckedChange={() => onToggleEvent(event)}
              label={<span className="font-mono font-normal">{event}</span>}
            />
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Label className="mb-0">{t("webhooks.payloadModeLabel")}</Label>
        <RadioGroup
          value={payloadMode}
          onValueChange={(v) => onPayloadModeChange(v as "full" | "summary")}
        >
          <div className="flex items-center gap-2">
            <RadioGroupItem value="full" id={`${idPrefix}payloadMode-full`} />
            <Label htmlFor={`${idPrefix}payloadMode-full`} className="cursor-pointer font-normal">
              {t("webhooks.payloadModeFull")}
            </Label>
          </div>
          <div className="flex items-center gap-2">
            <RadioGroupItem value="summary" id={`${idPrefix}payloadMode-summary`} />
            <Label
              htmlFor={`${idPrefix}payloadMode-summary`}
              className="cursor-pointer font-normal"
            >
              {t("webhooks.payloadModeSummary")}
            </Label>
          </div>
        </RadioGroup>
      </div>
    </>
  );
}
