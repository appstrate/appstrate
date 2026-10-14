// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { jsonText } from "@appstrate/afps-shared/json-text";
import { Modal } from "./modal";
import { ConfirmModal } from "./confirm-modal";
import { CopyButton } from "./copy-button";
import { Button } from "@appstrate/ui/components/button";
import { FieldError, FormItem } from "@appstrate/ui/components/field";
import { Input } from "@appstrate/ui/components/input";
import { Label } from "@appstrate/ui/components/label";
import { Badge } from "@appstrate/ui/components/badge";
import { Spinner } from "./spinner";
import { useDeleteEndUser, useUpdateEndUser, type EndUserInfo } from "../hooks/use-end-users";
import { usePermissions } from "../hooks/use-permissions";
import { formatDateField } from "../lib/format-date";
import { EndUserMetadataEditor } from "./end-user-metadata-editor";
import { entriesToMetadata, metadataToEntries, type MetadataEntry } from "../lib/end-user-metadata";
import { errorMessage } from "../lib/mutation-error";

interface Props {
  open: boolean;
  onClose: () => void;
  endUser: EndUserInfo | null;
  initialEditing?: boolean;
  onEditingChange?: (editing: boolean) => void;
  onDeleted?: (id: string) => void;
}

function CopyableField({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <Label className="text-muted-foreground text-xs">{label}</Label>
      <div className="flex items-center gap-2">
        <span className="text-sm break-all">{value}</span>
        <CopyButton value={value} />
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

export function EndUserDetailModal({
  open,
  onClose,
  endUser,
  initialEditing = false,
  onEditingChange,
  onDeleted,
}: Props) {
  const { t } = useTranslation(["settings", "common"]);
  const { can } = usePermissions();
  const deleteMutation = useDeleteEndUser();
  const updateMutation = useUpdateEndUser();
  const mounted = useRef(true);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [editing, setEditing] = useState(initialEditing);

  const [editName, setEditName] = useState(endUser?.name ?? "");
  const [editEmail, setEditEmail] = useState(endUser?.email ?? "");
  const [editExternalId, setEditExternalId] = useState(endUser?.externalId ?? "");
  const [editMetadata, setEditMetadata] = useState<MetadataEntry[]>(() =>
    metadataToEntries(endUser?.metadata ?? null),
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const startEditing = () => {
    if (!endUser) return;
    setEditName(endUser.name ?? "");
    setEditEmail(endUser.email ?? "");
    setEditExternalId(endUser.externalId ?? "");
    setEditMetadata(metadataToEntries(endUser.metadata));
    updateMutation.reset();
    setEditing(true);
    onEditingChange?.(true);
  };

  const stopEditing = () => {
    setEditing(false);
    onEditingChange?.(false);
  };

  const handleClose = () => {
    setEditing(false);
    onClose();
  };

  if (!endUser) return null;

  const metadata = endUser.metadata;
  const metaEntries = metadata ? Object.entries(metadata) : [];

  const handleSave = async () => {
    try {
      await updateMutation.mutateAsync({
        params: { path: { id: endUser.id } },
        body: {
          name: editName.trim() || undefined,
          email: editEmail.trim() || undefined,
          externalId: editExternalId.trim() || undefined,
          metadata: entriesToMetadata(editMetadata),
        },
      });
      if (!mounted.current) return;
      stopEditing();
    } catch {
      // Shown inline under the form (`errorHandledByCaller`).
    }
  };

  if (editing) {
    return (
      <>
        <Modal
          open={open}
          onClose={handleClose}
          preventClose={updateMutation.isPending}
          title={t("spaces.editEndUser")}
          actions={
            <>
              <Button
                type="button"
                variant="outline"
                onClick={stopEditing}
                disabled={updateMutation.isPending}
              >
                {t("common:btn.cancel")}
              </Button>
              <Button type="submit" form="edit-end-user-form" disabled={updateMutation.isPending}>
                {updateMutation.isPending ? (
                  <Spinner label={t("common:loading")} />
                ) : (
                  t("common:btn.save")
                )}
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
            <FormItem id="eu-edit-name" label={t("spaces.endUserName")}>
              <Input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder={t("spaces.endUserNamePlaceholder")}
                autoFocus
              />
            </FormItem>
            <FormItem id="eu-edit-email" label={t("spaces.endUserEmail")}>
              <Input
                type="email"
                value={editEmail}
                onChange={(e) => setEditEmail(e.target.value)}
                placeholder="alice@example.com"
              />
            </FormItem>
            <FormItem id="eu-edit-extid" label={t("spaces.endUserExternalId")}>
              <Input
                value={editExternalId}
                onChange={(e) => setEditExternalId(e.target.value)}
                placeholder="my_user_123"
              />
            </FormItem>

            <EndUserMetadataEditor entries={editMetadata} onChange={setEditMetadata} />

            {updateMutation.error && <FieldError>{errorMessage(updateMutation.error)}</FieldError>}
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
          can("end-users:delete") || can("end-users:write") ? (
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
            </>
          ) : undefined
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
                    <span>{jsonText(val ?? null)}</span>
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
        title={t("spaces.deleteEndUserTitle")}
        confirmLabel={t("common:btn.delete")}
        description={t("spaces.deleteEndUserConfirm")}
        isPending={deleteMutation.isPending}
        onConfirm={async () => {
          try {
            await deleteMutation.mutateAsync({ params: { path: { id: endUser.id } } });
            if (!mounted.current) return;
            setConfirmOpen(false);
            onDeleted?.(endUser.id);
            handleClose();
          } catch {
            // The mutation cache toasts the refusal and the dialog closes on it.
          }
        }}
      />
    </>
  );
}
