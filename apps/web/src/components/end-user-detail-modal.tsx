import { useTranslation } from "react-i18next";
import i18n from "../i18n";
import { Modal } from "./modal";
import { Button } from "@/components/ui/button";
import { Spinner } from "./spinner";
import { useDeleteEndUser, type EndUserInfo } from "../hooks/use-end-users";

interface Props {
  open: boolean;
  onClose: () => void;
  endUser: EndUserInfo | null;
}

function InfoRow({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div className="flex items-start gap-3 py-2">
      <span className="text-sm text-muted-foreground shrink-0 w-28">{label}</span>
      <span className="text-sm font-medium break-all">{value}</span>
    </div>
  );
}

export function EndUserDetailModal({ open, onClose, endUser }: Props) {
  const { t } = useTranslation(["settings", "common"]);
  const deleteMutation = useDeleteEndUser();

  if (!endUser) return null;

  const handleDelete = () => {
    if (!confirm(t("applications.deleteEndUserConfirm"))) return;
    deleteMutation.mutate(endUser.id, {
      onSuccess: () => onClose(),
    });
  };

  const metadata = endUser.metadata;
  const hasMetadata = metadata && Object.keys(metadata).length > 0;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={endUser.name || endUser.email || t("applications.endUserDetail")}
      actions={
        <Button type="button" variant="outline" onClick={onClose}>
          {t("btn.close")}
        </Button>
      }
    >
      {/* Identity */}
      <div className="space-y-0 divide-y divide-border">
        <InfoRow label="ID" value={endUser.id} />
        <InfoRow label={t("applications.endUserName")} value={endUser.name} />
        <InfoRow label={t("applications.endUserEmail")} value={endUser.email} />
        <InfoRow label={t("applications.endUserExternalId")} value={endUser.externalId} />
        <InfoRow
          label={t("applications.createdAtLabel")}
          value={new Date(endUser.createdAt).toLocaleDateString(i18n.language, {
            day: "numeric",
            month: "long",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })}
        />
      </div>

      {/* Metadata */}
      {hasMetadata && (
        <>
          <div className="text-sm font-medium text-muted-foreground mt-4 mb-2">
            {t("applications.metadata")}
          </div>
          <div className="rounded-md border border-border bg-muted/50 px-3 py-2">
            <pre className="text-xs font-mono whitespace-pre-wrap break-all">
              {JSON.stringify(metadata, null, 2)}
            </pre>
          </div>
        </>
      )}

      {/* Actions */}
      <div className="mt-4 pt-4 border-t border-border">
        <Button
          variant="destructive"
          size="sm"
          disabled={deleteMutation.isPending}
          onClick={handleDelete}
        >
          {deleteMutation.isPending ? <Spinner /> : t("applications.deleteEndUser")}
        </Button>
      </div>
    </Modal>
  );
}
