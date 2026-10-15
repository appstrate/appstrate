// SPDX-License-Identifier: Apache-2.0

import { PendingButton } from "@/components/app-ui/pending-button";
import { useRef, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@appstrate/ui/components/button";
import { Modal } from "./modal";
import type { AgentInputFormHandle } from "./agent-input-form";

/**
 * The frame of a run launch form: it stays open while the launch is in flight,
 * mounts the form afresh at each opening (so its fields seed from the agent
 * again), and its Run button submits the form's `AgentInputForm` through
 * `formRef`, which runs that form's validation before its `onSubmit`.
 */
export function RunLaunchModal({
  open,
  onClose,
  title,
  isPending,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  isPending?: boolean;
  /** The form's body; it hands `formRef` to its `AgentInputForm`. */
  children: (formRef: RefObject<AgentInputFormHandle | null>) => ReactNode;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const formRef = useRef<AgentInputFormHandle>(null);

  return (
    <Modal open={open} onClose={onClose} preventClose={isPending} title={title}>
      {open && (
        <div className="space-y-5">
          {children(formRef)}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" onClick={onClose} disabled={isPending}>
              {t("btn.cancel")}
            </Button>
            <PendingButton onClick={() => formRef.current?.submit()} pending={isPending}>
              {t("input.run")}
            </PendingButton>
          </div>
        </div>
      )}
    </Modal>
  );
}
