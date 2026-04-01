import { useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../i18n";
import { Modal } from "./modal";
import { ConfirmModal } from "./confirm-modal";
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
      <span className="text-muted-foreground w-28 shrink-0 text-sm">{label}</span>
      <span className="text-sm font-medium break-all">{value}</span>
    </div>
  );
}

export function EndUserDetailModal({ open, onClose, endUser }: Props) {
  const { t } = useTranslation(["settings", "common"]);
  const deleteMutation = useDeleteEndUser();
  const [confirmOpen, setConfirmOpen] = useState(false);

  if (!endUser) return null;

  const metadata = endUser.metadata;
  const hasMetadata = metadata && Object.keys(metadata).length > 0;

  return (
    <>
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
        <div className="divide-border space-y-0 divide-y">
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
            <div className="text-muted-foreground mt-4 mb-2 text-sm font-medium">
              {t("applications.metadata")}
            </div>
            <div className="border-border bg-muted/50 rounded-md border px-3 py-2">
              <pre className="font-mono text-xs break-all whitespace-pre-wrap">
                {JSON.stringify(metadata, null, 2)}
              </pre>
            </div>
          </>
        )}

        {/* Actions */}
        <div className="border-border mt-4 border-t pt-4">
          <Button
            variant="destructive"
            size="sm"
            disabled={deleteMutation.isPending}
            onClick={() => setConfirmOpen(true)}
          >
            {deleteMutation.isPending ? <Spinner /> : t("applications.deleteEndUser")}
          </Button>
        </div>
      </Modal>

      <ConfirmModal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={t("btn.confirm", { ns: "common" })}
        description={t("applications.deleteEndUserConfirm")}
        isPending={deleteMutation.isPending}
        onConfirm={() => {
          deleteMutation.mutate(endUser.id, {
            onSuccess: () => {
              setConfirmOpen(false);
              onClose();
            },
          });
        }}
      />
    </>
  );
}
