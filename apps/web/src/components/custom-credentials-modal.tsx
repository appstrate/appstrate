import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useForm, useWatch } from "react-hook-form";
import { Modal } from "./modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getOrderedKeys, type JSONSchemaObject } from "@appstrate/shared-types";

interface CustomCredentialsModalProps {
  open: boolean;
  onClose: () => void;
  schema: JSONSchemaObject;
  providerId: string;
  providerName?: string;
  isPending: boolean;
  onSubmit: (credentials: Record<string, string>) => void;
}

export function CustomCredentialsModal({
  open,
  onClose,
  schema,
  providerId,
  providerName,
  isPending,
  onSubmit,
}: CustomCredentialsModalProps) {
  const { t } = useTranslation(["settings", "common"]);
  const [visibleFields, setVisibleFields] = useState<Record<string, boolean>>({});

  const { setValue, reset, handleSubmit, control } = useForm<Record<string, string>>({
    defaultValues: {},
  });

  const values = useWatch({ control });

  const properties = schema?.properties ?? {};
  const required = schema?.required ?? [];

  const orderedKeys = getOrderedKeys(schema);
  const allRequiredFilled = required.every((key) => values[key]?.trim());

  const toggleVisibility = (key: string) => {
    setVisibleFields((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleClose = () => {
    reset({});
    setVisibleFields({});
    onClose();
  };

  const onFormSubmit = handleSubmit((data) => {
    const credentials: Record<string, string> = {};
    for (const key of Object.keys(properties)) {
      if (data[key]?.trim()) {
        credentials[key] = data[key].trim();
      }
    }
    onSubmit(credentials);
  });

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={t("customCreds.title", { name: providerName || providerId })}
    >
      {orderedKeys.map((key) => {
        const prop = properties[key];
        const isRequired = required.includes(key);
        const isVisible = visibleFields[key] ?? false;
        return (
          <div key={key} className="space-y-2">
            <Label htmlFor={`cred-${key}`}>
              {prop.description || key}
              {isRequired && " *"}
            </Label>
            <div className="flex items-center gap-1">
              <Input
                id={`cred-${key}`}
                type={isVisible ? "text" : "password"}
                value={values[key] ?? ""}
                onChange={(e) => setValue(key, e.target.value)}
                placeholder={key}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && allRequiredFilled && !isPending) onFormSubmit();
                }}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="text-muted-foreground hover:text-foreground text-sm"
                onClick={() => toggleVisibility(key)}
                tabIndex={-1}
              >
                {isVisible ? "\u25E1" : "\u29BF"}
              </Button>
            </div>
          </div>
        );
      })}
      <div className="flex justify-end gap-2 mt-4 pt-4 border-t border-border">
        <Button variant="outline" onClick={handleClose}>
          {t("btn.cancel")}
        </Button>
        <Button onClick={onFormSubmit} disabled={!allRequiredFilled || isPending}>
          {t("btn.save")}
        </Button>
      </div>
    </Modal>
  );
}
