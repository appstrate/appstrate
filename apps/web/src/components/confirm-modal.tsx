import { useTranslation } from "react-i18next";
import { Modal } from "./modal";
import { Button } from "@/components/ui/button";
import { Spinner } from "./spinner";

interface ConfirmModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description: string;
  confirmLabel?: string;
  variant?: "default" | "destructive";
  isPending?: boolean;
}

export function ConfirmModal({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel,
  variant = "destructive",
  isPending,
}: ConfirmModalProps) {
  const { t } = useTranslation("common");

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      actions={
        <>
          <Button variant="outline" onClick={onClose} disabled={isPending}>
            {t("btn.cancel")}
          </Button>
          <Button variant={variant} onClick={onConfirm} disabled={isPending}>
            {isPending ? <Spinner /> : (confirmLabel ?? t("btn.confirm"))}
          </Button>
        </>
      }
    >
      <p className="text-sm text-muted-foreground">{description}</p>
    </Modal>
  );
}
