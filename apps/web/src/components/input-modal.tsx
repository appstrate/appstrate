// SPDX-License-Identifier: Apache-2.0

import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type RjsfForm from "@rjsf/core";
import { Modal } from "./modal";
import { Button } from "@/components/ui/button";
import { Spinner } from "./spinner";
import { SchemaForm } from "@appstrate/ui/schema-form";
import type { SchemaWrapper, JSONSchemaObject } from "@appstrate/core/form";
import { useSchemaFormLabels } from "../hooks/use-schema-form-labels";
import type { AgentDetail } from "@appstrate/shared-types";

interface InputModalProps {
  open: boolean;
  onClose: () => void;
  agent: AgentDetail;
  onSubmit: (input: Record<string, unknown>) => void;
  isPending?: boolean;
  initialValues?: Record<string, unknown>;
}

const EMPTY_SCHEMA: JSONSchemaObject = { type: "object", properties: {} };

export function InputModal({
  open,
  onClose,
  agent,
  onSubmit,
  isPending,
  initialValues,
}: InputModalProps) {
  const { t } = useTranslation(["agents", "common"]);

  const guardedClose = () => {
    if (!isPending) onClose();
  };

  return (
    <Modal
      open={open}
      onClose={guardedClose}
      title={t("input.title", { name: agent.displayName })}
      actions={null}
    >
      {open && (
        <InputModalForm
          agent={agent}
          onClose={guardedClose}
          onSubmit={onSubmit}
          isPending={isPending}
          initialValues={initialValues}
        />
      )}
    </Modal>
  );
}

function InputModalForm({
  agent,
  onClose,
  onSubmit,
  isPending,
  initialValues,
}: {
  agent: AgentDetail;
  onClose: () => void;
  onSubmit: (input: Record<string, unknown>) => void;
  isPending?: boolean;
  initialValues?: Record<string, unknown>;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const wrapper: SchemaWrapper = agent.input ?? { schema: EMPTY_SCHEMA };
  const [formData, setFormData] = useState<Record<string, unknown>>(initialValues ?? {});
  const formRef = useRef<RjsfForm>(null);
  const labels = useSchemaFormLabels();

  return (
    <>
      <SchemaForm
        ref={formRef}
        wrapper={wrapper}
        formData={formData}
        uploadPath="/api/uploads"
        labels={labels}
        onChange={(e) => setFormData(e.formData as Record<string, unknown>)}
        onSubmit={(e) => onSubmit(e.formData as Record<string, unknown>)}
      />
      <div className="flex justify-end gap-2 pt-4">
        <Button variant="outline" onClick={onClose} disabled={isPending}>
          {t("btn.cancel")}
        </Button>
        <Button onClick={() => formRef.current?.submit()} disabled={isPending}>
          {isPending ? <Spinner /> : t("input.run")}
        </Button>
      </div>
    </>
  );
}
