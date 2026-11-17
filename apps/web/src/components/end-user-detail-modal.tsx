// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { jsonText } from "@appstrate/afps-shared/json-text";
import { Modal } from "./modal";
import { FormModal } from "./form-modal";
import { ConfirmModal } from "./confirm-modal";
import { CopyButton } from "@appstrate/ui/components/copy-button";
import { Button } from "@appstrate/ui/components/button";
import { Fact, FactGrid } from "@appstrate/ui/components/fact-grid";
import { Badge } from "@appstrate/ui/components/badge";
import { useDeleteEndUser, useUpdateEndUser, type EndUserInfo } from "../hooks/use-end-users";
import { usePermissions } from "../hooks/use-permissions";
import { endUserLabel } from "../lib/members";
import { formatDateField } from "../lib/format-date";
import { EndUserFields, type EndUserFormValues } from "./end-user-fields";
import { entriesToMetadata, metadataToEntries } from "../lib/end-user-metadata";
import { errorMessage } from "../lib/mutation-error";

interface Props {
  onClose: () => void;
  endUser: EndUserInfo | null;
  /** The edition is a state of the page; the host owns both. */
  editing: boolean;
  onEdit: () => void;
  /** Leaves the edition for the detail it was entered from. */
  onShowDetail: () => void;
}

function formValues(endUser: EndUserInfo | null): EndUserFormValues {
  return {
    name: endUser?.name ?? "",
    email: endUser?.email ?? "",
    externalId: endUser?.externalId ?? "",
    metadata: metadataToEntries(endUser?.metadata ?? null),
  };
}

export function EndUserDetailModal({ onClose, endUser, editing, onEdit, onShowDetail }: Props) {
  const { t } = useTranslation(["settings", "common"]);
  const { can } = usePermissions();
  const deleteMutation = useDeleteEndUser();
  const updateMutation = useUpdateEndUser();
  const mounted = useRef(true);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // An edition reached from the detail returns to it; one opened from the list's
  // deed closes.
  const [enteredFromDetail] = useState(!editing);

  const [editValues, setEditValues] = useState(() => formValues(endUser));

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const startEditing = () => {
    if (!endUser) return;
    setEditValues(formValues(endUser));
    updateMutation.reset();
    onEdit();
  };

  const stopEditing = enteredFromDetail ? onShowDetail : onClose;

  if (!endUser) return null;

  const metadata = endUser.metadata;
  const metaEntries = metadata ? Object.entries(metadata) : [];

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await updateMutation.mutateAsync({
        params: { path: { id: endUser.id } },
        body: {
          name: editValues.name.trim() || undefined,
          email: editValues.email.trim() || undefined,
          externalId: editValues.externalId.trim() || undefined,
          metadata: entriesToMetadata(editValues.metadata),
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
      <FormModal
        onClose={stopEditing}
        title={t("common:btn.edit")}
        onSubmit={handleSave}
        isPending={updateMutation.isPending}
        error={updateMutation.error ? errorMessage(updateMutation.error) : null}
      >
        <EndUserFields values={editValues} onChange={setEditValues} />
      </FormModal>
    );
  }

  return (
    <>
      <Modal
        onClose={onClose}
        title={endUserLabel(endUser, t("spaces.endUserDetail"))}
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
        <FactGrid columns={1} className="gap-y-4">
          <Fact label="ID">
            <div className="flex items-center gap-2">
              <span className="break-all">{endUser.id}</span>
              <CopyButton value={endUser.id} />
            </div>
          </Fact>
          {endUser.name && <Fact label={t("spaces.nameLabel")}>{endUser.name}</Fact>}
          {endUser.email && <Fact label={t("login.email")}>{endUser.email}</Fact>}
          {endUser.externalId && (
            <Fact label={t("spaces.endUserExternalId")}>{endUser.externalId}</Fact>
          )}
          <Fact label={t("spaces.createdAtLabel")}>{formatDateField(endUser.createdAt)}</Fact>
          {metaEntries.length > 0 && (
            <Fact label={t("spaces.metadata")}>
              <div className="flex flex-wrap gap-1.5">
                {metaEntries.map(([key, val]) => (
                  <Badge key={key} variant="outline" className="text-xs font-normal">
                    <span className="font-medium">{key}</span>
                    <span className="text-muted-foreground mx-1">:</span>
                    <span>{jsonText(val ?? null)}</span>
                  </Badge>
                ))}
              </div>
            </Fact>
          )}
        </FactGrid>
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
            onClose();
          } catch {
            // The mutation cache toasts the refusal and the dialog closes on it.
          }
        }}
      />
    </>
  );
}
