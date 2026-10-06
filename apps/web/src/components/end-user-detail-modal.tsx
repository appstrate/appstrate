// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy } from "lucide-react";
import { Modal } from "./modal";
import { ConfirmModal } from "./confirm-modal";
import { Button } from "@appstrate/ui/components/button";
import { Input } from "@appstrate/ui/components/input";
import { Label } from "@appstrate/ui/components/label";
import { Badge } from "@appstrate/ui/components/badge";
import { Spinner } from "./spinner";
import { useDeleteEndUser, useUpdateEndUser, type EndUserInfo } from "../hooks/use-end-users";
import { usePermissions } from "../hooks/use-permissions";
import { formatDateField } from "../lib/format-date";
import { EndUserMetadataEditor } from "./end-user-metadata-editor";
import { entriesToMetadata, metadataToEntries, type MetadataEntry } from "../lib/end-user-metadata";
import { useCopyToClipboard } from "../hooks/use-copy-to-clipboard";

interface Props {
  open: boolean;
  onClose: () => void;
  endUser: EndUserInfo | null;
}

function CopyableField({ label, value }: { label: string; value: string }) {
  const { copied, copy } = useCopyToClipboard(1500);
  const { t } = useTranslation("common");

  const handleCopy = () => void copy(value);

  return (
    <div className="space-y-1">
      <Label className="text-muted-foreground text-xs">{label}</Label>
      <div className="flex items-center gap-2">
        <span className="text-sm break-all">{value}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="text-muted-foreground hover:text-foreground shrink-0 transition-colors"
        >
          {copied ? <span className="text-xs">{t("btn.copied")}</span> : <Copy size={12} />}
        </button>
      </div>
    </div>
  );
}

function ReadOnlyField({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div className="space-y-1">
      <Label className="text-muted-foreground text-xs">{label}</Label>
      <p className="text-sm">{value}</p>
    </div>
  );
}

export function EndUserDetailModal({ open, onClose, endUser }: Props) {
  const { t } = useTranslation(["settings", "common"]);
  const { can } = usePermissions();
  const deleteMutation = useDeleteEndUser();
  const updateMutation = useUpdateEndUser();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [editing, setEditing] = useState(false);

  const [editName, setEditName] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [editExternalId, setEditExternalId] = useState("");
  const [editMetadata, setEditMetadata] = useState<MetadataEntry[]>([]);

  const startEditing = () => {
    if (!endUser) return;
    setEditName(endUser.name ?? "");
    setEditEmail(endUser.email ?? "");
    setEditExternalId(endUser.externalId ?? "");
    setEditMetadata(metadataToEntries(endUser.metadata));
    updateMutation.reset();
    setEditing(true);
  };

  const handleClose = () => {
    setEditing(false);
    onClose();
  };

  if (!endUser) return null;

  const metadata = endUser.metadata;
  const metaEntries = metadata ? Object.entries(metadata) : [];

  const handleSave = () => {
    updateMutation.mutate(
      {
        params: { path: { id: endUser.id } },
        body: {
          name: editName.trim() || undefined,
          email: editEmail.trim() || undefined,
          externalId: editExternalId.trim() || undefined,
          metadata: entriesToMetadata(editMetadata),
        },
      },
      {
        onSuccess: () => {
          setEditing(false);
        },
      },
    );
  };

  if (editing) {
    return (
      <>
        <Modal
          open={open}
          onClose={handleClose}
          title={t("spaces.editEndUser")}
          actions={
            <>
              <Button
                type="button"
                variant="outline"
                onClick={() => setEditing(false)}
                disabled={updateMutation.isPending}
              >
                {t("common:btn.cancel")}
              </Button>
              <Button type="submit" form="edit-end-user-form" disabled={updateMutation.isPending}>
                {updateMutation.isPending ? <Spinner /> : t("common:btn.save")}
              </Button>
            </>
          }
        >
          <form
            id="edit-end-user-form"
            onSubmit={(e) => {
              e.preventDefault();
              handleSave();
            }}
            className="space-y-4"
          >
            <div className="space-y-2">
              <Label htmlFor="eu-edit-name">{t("spaces.endUserName")}</Label>
              <Input
                id="eu-edit-name"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder={t("spaces.endUserNamePlaceholder")}
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="eu-edit-email">{t("spaces.endUserEmail")}</Label>
              <Input
                id="eu-edit-email"
                type="email"
                value={editEmail}
                onChange={(e) => setEditEmail(e.target.value)}
                placeholder="alice@example.com"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="eu-edit-extid">{t("spaces.endUserExternalId")}</Label>
              <Input
                id="eu-edit-extid"
                value={editExternalId}
                onChange={(e) => setEditExternalId(e.target.value)}
                placeholder="my_user_123"
              />
            </div>

            <EndUserMetadataEditor entries={editMetadata} onChange={setEditMetadata} />

            {updateMutation.error && (
              <p className="text-destructive text-sm">
                {updateMutation.error instanceof Error
                  ? updateMutation.error.message
                  : String(updateMutation.error)}
              </p>
            )}
          </form>
        </Modal>
      </>
    );
  }

  return (
    <>
      <Modal
        open={open}
        onClose={handleClose}
        title={endUser.name || endUser.email || t("spaces.endUserDetail")}
        actions={
          <>
            {can("end-users:delete") && (
              <Button variant="destructive" size="sm" onClick={() => setConfirmOpen(true)}>
                {t("common:btn.delete")}
              </Button>
            )}
            <div className="flex-1" />
            {can("end-users:write") && (
              <Button variant="outline" onClick={startEditing}>
                {t("common:btn.edit")}
              </Button>
            )}
            <Button variant="outline" onClick={handleClose}>
              {t("common:btn.close")}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <CopyableField label="ID" value={endUser.id} />
          <ReadOnlyField label={t("spaces.endUserName")} value={endUser.name} />
          <ReadOnlyField label={t("spaces.endUserEmail")} value={endUser.email} />
          <ReadOnlyField label={t("spaces.endUserExternalId")} value={endUser.externalId} />
          <ReadOnlyField
            label={t("spaces.createdAtLabel")}
            value={formatDateField(endUser.createdAt)}
          />

          {metaEntries.length > 0 && (
            <div className="space-y-2">
              <Label className="text-muted-foreground text-xs">{t("spaces.metadata")}</Label>
              <div className="flex flex-wrap gap-1.5">
                {metaEntries.map(([key, val]) => (
                  <Badge key={key} variant="outline" className="text-xs font-normal">
                    <span className="font-medium">{key}</span>
                    <span className="text-muted-foreground mx-1">:</span>
                    <span>{typeof val === "string" ? val : JSON.stringify(val)}</span>
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </div>
      </Modal>

      <ConfirmModal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={t("common:btn.confirm")}
        description={t("spaces.deleteEndUserConfirm")}
        isPending={deleteMutation.isPending}
        onConfirm={() => {
          deleteMutation.mutate(
            { params: { path: { id: endUser.id } } },
            {
              onSuccess: () => {
                setConfirmOpen(false);
                handleClose();
              },
            },
          );
        }}
      />
    </>
  );
}
