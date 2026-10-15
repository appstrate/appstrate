// SPDX-License-Identifier: Apache-2.0

import { PendingButton } from "@/components/app-ui/pending-button";
import { useId, type ComponentProps, type FormEventHandler, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@appstrate/ui/components/button";
import { FieldError } from "@appstrate/ui/components/field";
import { Modal } from "./modal";

interface FormModalProps {
  title: string;
  onClose: () => void;
  onSubmit: FormEventHandler<HTMLFormElement>;
  /** The request is in flight: the modal does not close and Cancel is disabled. */
  isPending?: boolean;
  /** Defaults to « Save ». */
  submitLabel?: string;
  submitDisabled?: boolean;
  submitTestId?: string;
  /** The submission's refusal, shown under the fields. */
  error?: string | null;
  /** Left of Cancel, for an action that belongs to the form (a connection test). */
  secondaryActions?: ReactNode;
  /** The dialog's own classes. */
  className?: string;
  /** The form attributes a caller needs; a `className` replaces the default `flex flex-col gap-4`. */
  formProps?: Pick<ComponentProps<"form">, "noValidate" | "onChange" | "className">;
  children: ReactNode;
}

/**
 * A modal around one form: the footer's Cancel and submit are wired to it, so a caller supplies
 * the fields and the submit handler. Mount it while open: closing abandons what was typed.
 */
export function FormModal({
  title,
  onClose,
  onSubmit,
  isPending = false,
  submitLabel,
  submitDisabled = false,
  submitTestId,
  error,
  secondaryActions,
  className,
  formProps,
  children,
}: FormModalProps) {
  const { t } = useTranslation("common");
  const formId = useId();

  return (
    <Modal
      onClose={onClose}
      preventClose={isPending}
      title={title}
      className={className}
      actions={
        <>
          {secondaryActions}
          <Button type="button" variant="outline" onClick={onClose} disabled={isPending}>
            {t("btn.cancel")}
          </Button>
          <PendingButton
            type="submit"
            form={formId}
            data-testid={submitTestId}
            pending={isPending}
            disabled={submitDisabled}
          >
            {submitLabel ?? t("btn.save")}
          </PendingButton>
        </>
      }
    >
      <form className="flex flex-col gap-4" {...formProps} id={formId} onSubmit={onSubmit}>
        {children}
        <FieldError>{error}</FieldError>
      </form>
    </Modal>
  );
}
