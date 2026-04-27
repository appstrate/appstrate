import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import type RjsfForm from "@rjsf/core";
import { Modal } from "./modal";
import { Button } from "@/components/ui/button";
import { Spinner } from "./spinner";
import { SchemaForm } from "@appstrate/ui/schema-form";
import type { SchemaWrapper, JSONSchemaObject } from "@appstrate/core/form";
import { useSchemaFormLabels } from "../hooks/use-schema-form-labels";
import { uploadClient } from "../api";
import {
  useAppProfiles,
  useConnectionProfiles,
  useMyApplicationProfile,
} from "../hooks/use-connection-profiles";
import type { AgentDetail } from "@appstrate/shared-types";

interface RunModalProps {
  open: boolean;
  onClose: () => void;
  agent: AgentDetail;
  onSubmit: (input: Record<string, unknown>) => void;
  isPending?: boolean;
  initialInput?: Record<string, unknown>;
}

const EMPTY_SCHEMA: JSONSchemaObject = { type: "object", properties: {} };

export function RunModal({
  open,
  onClose,
  agent,
  onSubmit,
  isPending,
  initialInput,
}: RunModalProps) {
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
        <RunModalForm
          agent={agent}
          onClose={guardedClose}
          onSubmit={onSubmit}
          isPending={isPending}
          initialInput={initialInput}
        />
      )}
    </Modal>
  );
}

function RunModalForm({
  agent,
  onClose,
  onSubmit,
  isPending,
  initialInput,
}: {
  agent: AgentDetail;
  onClose: () => void;
  onSubmit: (input: Record<string, unknown>) => void;
  isPending?: boolean;
  initialInput?: Record<string, unknown>;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const inputWrapper: SchemaWrapper = agent.input ?? { schema: EMPTY_SCHEMA };
  const hasInputFields =
    !!inputWrapper.schema?.properties && Object.keys(inputWrapper.schema.properties).length > 0;
  const [inputData, setInputData] = useState<Record<string, unknown>>(initialInput ?? {});
  const inputFormRef = useRef<RjsfForm>(null);
  const labels = useSchemaFormLabels();

  // Resolve the member's pinned default profile for the active app — only
  // shown when set, as a confirmation that a personal preference is in
  // effect. Absence falls through to the application default silently;
  // we don't surface that branch to keep the modal focused.
  const { data: sticky } = useMyApplicationProfile();
  const { data: userProfiles } = useConnectionProfiles();
  const { data: appProfiles } = useAppProfiles();
  const stickyProfile = sticky?.profileId
    ? (userProfiles?.find((p) => p.id === sticky.profileId) ??
      appProfiles?.find((p) => p.id === sticky.profileId) ??
      null)
    : null;

  const handleSubmit = () => {
    if (hasInputFields && inputFormRef.current) {
      inputFormRef.current.submit();
      return;
    }
    onSubmit(inputData);
  };

  return (
    <div className="space-y-5">
      {hasInputFields && (
        <div className="space-y-2">
          <SchemaForm
            ref={inputFormRef}
            wrapper={inputWrapper}
            formData={inputData}
            upload={uploadClient}
            labels={labels}
            onChange={(e) => setInputData(e.formData as Record<string, unknown>)}
            onSubmit={(e) => onSubmit(e.formData as Record<string, unknown>)}
          />
        </div>
      )}

      {stickyProfile && (
        <p className="text-muted-foreground text-xs">
          {t("run.modal.profileBadge")}{" "}
          <span className="text-foreground font-medium">{stickyProfile.name}</span>{" "}
          <Link
            to="/preferences/profiles"
            className="text-primary underline-offset-2 hover:underline"
          >
            ({t("run.modal.profileChange")})
          </Link>
        </p>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <Button variant="outline" onClick={onClose} disabled={isPending}>
          {t("btn.cancel")}
        </Button>
        <Button onClick={handleSubmit} disabled={isPending}>
          {isPending ? <Spinner /> : t("input.run")}
        </Button>
      </div>
    </div>
  );
}
