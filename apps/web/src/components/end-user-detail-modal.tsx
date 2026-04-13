// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Plus, Trash2 } from "lucide-react";
import i18n from "../i18n";
import { Modal } from "./modal";
import { ConfirmModal } from "./confirm-modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "./spinner";
import { useDeleteEndUser, useUpdateEndUser, type EndUserInfo } from "../hooks/use-end-users";

interface Props {
  open: boolean;
  onClose: () => void;
  endUser: EndUserInfo | null;
}

interface MetadataEntry {
  key: string;
  value: string;
}

function metadataToEntries(metadata: Record<string, unknown> | null): MetadataEntry[] {
  if (!metadata) return [];
  return Object.entries(metadata).map(([key, value]) => ({
    key,
    value: typeof value === "string" ? value : JSON.stringify(value),
  }));
}

function entriesToMetadata(entries: MetadataEntry[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of entries) {
    const k = entry.key.trim();
    if (k) result[k] = entry.value;
  }
  return result;
}

function CopyableField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const { t } = useTranslation("common");

  const handleCopy = () => {
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

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
        id: endUser.id,
        data: {
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

  const handleMetadataChange = (index: number, field: "key" | "value", val: string) => {
    setEditMetadata((prev) => prev.map((e, i) => (i === index ? { ...e, [field]: val } : e)));
  };

  const handleMetadataRemove = (index: number) => {
    setEditMetadata((prev) => prev.filter((_, i) => i !== index));
  };

  const handleMetadataAdd = () => {
    setEditMetadata((prev) => [...prev, { key: "", value: "" }]);
  };

  if (editing) {
    return (
      <>
        <Modal
          open={open}
          onClose={handleClose}
          title={t("applications.editEndUser")}
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
              <Label htmlFor="eu-edit-name">{t("applications.endUserName")}</Label>
              <Input
                id="eu-edit-name"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder={t("applications.endUserNamePlaceholder")}
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="eu-edit-email">{t("applications.endUserEmail")}</Label>
              <Input
                id="eu-edit-email"
                type="email"
                value={editEmail}
                onChange={(e) => setEditEmail(e.target.value)}
                placeholder="alice@example.com"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="eu-edit-extid">{t("applications.endUserExternalId")}</Label>
              <Input
                id="eu-edit-extid"
                value={editExternalId}
                onChange={(e) => setEditExternalId(e.target.value)}
                placeholder="my_user_123"
              />
            </div>

            <div className="space-y-2">
              <Label>{t("applications.metadata")}</Label>
              <div className="space-y-2">
                {editMetadata.map((entry, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <Input
                      value={entry.key}
                      onChange={(e) => handleMetadataChange(index, "key", e.target.value)}
                      placeholder={t("applications.metadataKey")}
                      className="flex-1"
                    />
                    <Input
                      value={entry.value}
                      onChange={(e) => handleMetadataChange(index, "value", e.target.value)}
                      placeholder={t("applications.metadataValue")}
                      className="flex-1"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      onClick={() => handleMetadataRemove(index)}
                    >
                      <Trash2 size={14} />
                    </Button>
                  </div>
                ))}
              </div>
              <Button type="button" variant="outline" size="sm" onClick={handleMetadataAdd}>
                <Plus size={14} className="mr-1" />
                {t("applications.addMetadataKey")}
              </Button>
            </div>

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
        title={endUser.name || endUser.email || t("applications.endUserDetail")}
        actions={
          <>
            <Button variant="destructive" size="sm" onClick={() => setConfirmOpen(true)}>
              {t("common:btn.delete")}
            </Button>
            <div className="flex-1" />
            <Button variant="outline" onClick={startEditing}>
              {t("common:btn.edit")}
            </Button>
            <Button variant="outline" onClick={handleClose}>
              {t("common:btn.close")}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <CopyableField label="ID" value={endUser.id} />
          <ReadOnlyField label={t("applications.endUserName")} value={endUser.name} />
          <ReadOnlyField label={t("applications.endUserEmail")} value={endUser.email} />
          <ReadOnlyField label={t("applications.endUserExternalId")} value={endUser.externalId} />
          <ReadOnlyField
            label={t("applications.createdAtLabel")}
            value={new Date(endUser.createdAt).toLocaleDateString(i18n.language, {
              day: "numeric",
              month: "long",
              year: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          />

          {metaEntries.length > 0 && (
            <div className="space-y-2">
              <Label className="text-muted-foreground text-xs">{t("applications.metadata")}</Label>
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
        description={t("applications.deleteEndUserConfirm")}
        isPending={deleteMutation.isPending}
        onConfirm={() => {
          deleteMutation.mutate(endUser.id, {
            onSuccess: () => {
              setConfirmOpen(false);
              handleClose();
            },
          });
        }}
      />
    </>
  );
}
