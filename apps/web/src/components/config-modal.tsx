import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "./modal";
import { Button } from "@/components/ui/button";
import { FormField } from "./form-field";
import { useSaveConfig } from "../hooks/use-mutations";
import type { FlowDetail } from "@appstrate/shared-types";

interface ConfigModalProps {
  open: boolean;
  onClose: () => void;
  flow: FlowDetail;
}

export function ConfigModal({ open, onClose, flow }: ConfigModalProps) {
  const { t } = useTranslation(["flows", "common"]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("config.title", { name: flow.displayName })}
      actions={null}
    >
      {open && <ConfigModalForm flow={flow} onClose={onClose} />}
    </Modal>
  );
}

function ConfigModalForm({ flow, onClose }: { flow: FlowDetail; onClose: () => void }) {
  const { t } = useTranslation(["flows", "common"]);
  const schema = flow.config?.schema;
  const current = flow.config?.current || {};
  const mutation = useSaveConfig(flow.id);

  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    if (schema?.properties) {
      for (const [key, prop] of Object.entries(schema.properties)) {
        initial[key] = String(current[key] ?? prop.default ?? "");
      }
    }
    return initial;
  });

  const handleSave = () => {
    const config: Record<string, unknown> = {};
    if (schema?.properties) {
      for (const [key, prop] of Object.entries(schema.properties)) {
        let value: unknown = values[key];
        if (prop.type === "number" && value) value = Number(value);
        config[key] = value || null;
      }
    }
    mutation.mutate(config, { onSuccess: onClose });
  };

  return (
    <>
      {schema?.properties &&
        Object.entries(schema.properties).map(([key, prop]) => (
          <FormField
            key={key}
            id={`config-${key}`}
            label={key}
            required={schema.required?.includes(key)}
            type={prop.type === "number" ? "number" : "text"}
            value={values[key] || ""}
            onChange={(v) => setValues((prev) => ({ ...prev, [key]: v }))}
            placeholder={prop.description}
            description={prop.description}
            enumValues={prop.enum as string[] | undefined}
          />
        ))}
      <div className="flex justify-end gap-2 pt-4">
        <Button variant="outline" onClick={onClose}>
          {t("btn.cancel")}
        </Button>
        <Button onClick={handleSave} disabled={mutation.isPending}>
          {t("btn.save")}
        </Button>
      </div>
    </>
  );
}
