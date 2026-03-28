import type { Dispatch, SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { WEBHOOK_EVENTS } from "../hooks/use-webhooks";

/** Toggle an event in a state setter — shared by create and edit forms. */
export function toggleEvent(event: string, setter: Dispatch<SetStateAction<string[]>>) {
  setter((prev) => (prev.includes(event) ? prev.filter((e) => e !== event) : [...prev, event]));
}

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
      <div className="space-y-2">
        <Label>{t("webhooks.eventsLabel")}</Label>
        <div className="space-y-2">
          {WEBHOOK_EVENTS.map((event) => (
            <div key={event} className="flex items-center gap-2">
              <Checkbox
                id={`${idPrefix}event-${event}`}
                checked={selectedEvents.includes(event)}
                onCheckedChange={() => onToggleEvent(event)}
              />
              <Label htmlFor={`${idPrefix}event-${event}`} className="font-mono font-normal cursor-pointer">
                {event}
              </Label>
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <Label>{t("webhooks.payloadModeLabel")}</Label>
        <RadioGroup
          value={payloadMode}
          onValueChange={(v) => onPayloadModeChange(v as "full" | "summary")}
        >
          <div className="flex items-center gap-2">
            <RadioGroupItem value="full" id={`${idPrefix}payloadMode-full`} />
            <Label htmlFor={`${idPrefix}payloadMode-full`} className="font-normal cursor-pointer">
              {t("webhooks.payloadModeFull")}
            </Label>
          </div>
          <div className="flex items-center gap-2">
            <RadioGroupItem value="summary" id={`${idPrefix}payloadMode-summary`} />
            <Label
              htmlFor={`${idPrefix}payloadMode-summary`}
              className="font-normal cursor-pointer"
            >
              {t("webhooks.payloadModeSummary")}
            </Label>
          </div>
        </RadioGroup>
      </div>
    </>
  );
}
