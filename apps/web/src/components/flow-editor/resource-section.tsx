import { useRef, useState } from "react";
import type { ResourceEntry } from "./types";
import { FormField } from "../form-field";
import { Modal } from "../modal";
import { Spinner } from "../spinner";

interface ResourceSectionProps {
  title: string;
  emptyLabel: string;
  items: ResourceEntry[];
  onChange: (items: ResourceEntry[]) => void;
  canEdit: boolean;
  addMutation: {
    mutate: (args: { file: File; updatedAt: string }, opts: { onSuccess: () => void }) => void;
    isPending: boolean;
  };
  removeMutation: {
    mutate: (args: { id: string; updatedAt: string }) => void;
    isPending: boolean;
  };
  updatedAt: string | undefined;
}

export function ResourceSection({
  title,
  emptyLabel,
  items,
  onChange,
  canEdit,
  addMutation,
  removeMutation,
  updatedAt,
}: ResourceSectionProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [editing, setEditing] = useState<{
    id: string;
    name: string;
    description: string;
  } | null>(null);

  const handleAdd = () => {
    if (!file || !updatedAt) return;
    addMutation.mutate(
      { file, updatedAt },
      {
        onSuccess: () => {
          setFile(null);
          if (fileRef.current) fileRef.current.value = "";
        },
      },
    );
  };

  const handleRemove = (id: string) => {
    if (!updatedAt) return;
    if (!confirm(`Supprimer '${id}' ?`)) return;
    removeMutation.mutate({ id, updatedAt });
  };

  const handleSaveEdit = () => {
    if (!editing) return;
    onChange(
      items.map((item) =>
        item.id === editing.id
          ? { id: item.id, name: editing.name || undefined, description: editing.description || undefined }
          : item,
      ),
    );
    setEditing(null);
  };

  const anyPending = addMutation.isPending || removeMutation.isPending;

  return (
    <div className="editor-section">
      <div className="editor-section-header">{title}</div>
      <div className="editor-section-body">
        {items.length > 0 ? (
          <div className="package-items">
            {items.map((item) => (
              <div key={item.id} className="package-item">
                <div className="package-item-info">
                  <strong>{item.name || item.id}</strong>
                  {item.description && <span className="package-item-desc">{item.description}</span>}
                </div>
                {canEdit && (
                  <div className="skill-actions">
                    <button
                      type="button"
                      className="btn-icon"
                      onClick={() =>
                        setEditing({ id: item.id, name: item.name ?? "", description: item.description ?? "" })
                      }
                      disabled={anyPending}
                      title="Modifier"
                    >
                      &#9998;
                    </button>
                    <button
                      type="button"
                      className="btn-remove"
                      onClick={() => handleRemove(item.id)}
                      disabled={anyPending}
                      title="Supprimer"
                    >
                      &times;
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="editor-hint">{emptyLabel}</p>
        )}

        {canEdit && (
          <div className="package-add-form">
            <label className="btn-upload btn-upload-sm flex-1">
              {file ? file.name : "Choisir un ZIP"}
              <input
                ref={fileRef}
                type="file"
                accept=".zip"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                style={{ display: "none" }}
              />
            </label>
            <button
              type="button"
              className="add-field-btn-inline"
              onClick={handleAdd}
              disabled={!file || addMutation.isPending}
            >
              {addMutation.isPending ? <Spinner /> : "Ajouter"}
            </button>
          </div>
        )}
      </div>

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={`Modifier — ${editing?.id ?? ""}`}
        actions={
          <>
            <button type="button" className="btn" onClick={() => setEditing(null)}>
              Annuler
            </button>
            <button type="button" className="btn btn-primary" onClick={handleSaveEdit}>
              Appliquer
            </button>
          </>
        }
      >
        {editing && (
          <div className="modal-form-fields">
            <FormField
              id="resource-name"
              label="Nom"
              value={editing.name}
              onChange={(v) => setEditing({ ...editing, name: v })}
              placeholder={editing.id}
            />
            <FormField
              id="resource-description"
              label="Description"
              value={editing.description}
              onChange={(v) => setEditing({ ...editing, description: v })}
            />
          </div>
        )}
      </Modal>
    </div>
  );
}
