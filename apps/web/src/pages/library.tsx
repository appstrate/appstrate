import { useState, useRef } from "react";
import {
  useOrgSkills,
  useOrgExtensions,
  useUploadSkill,
  useUploadExtension,
  useDeleteSkill,
  useDeleteExtension,
} from "../hooks/use-library";
import { useOrg } from "../hooks/use-org";
import { Spinner } from "../components/spinner";
import { Modal } from "../components/modal";
import { LibraryItemDetail } from "../components/library-item-detail";
import type { OrgSkill, OrgExtension } from "@appstrate/shared-types";

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

type LibraryType = "skills" | "extensions";

const TAB_CONFIG = {
  skills: {
    useList: useOrgSkills,
    useUpload: useUploadSkill,
    useDelete: useDeleteSkill,
    uploadLabel: "Uploader un skill (.zip)",
    emptyLabel: "Aucun skill dans la bibliotheque.",
    detailType: "skill" as const,
    detailPrefix: "Skill",
    deleteConfirm: (item: OrgSkill | OrgExtension) =>
      `Supprimer le skill "${item.name || item.id}" ?`,
  },
  extensions: {
    useList: useOrgExtensions,
    useUpload: useUploadExtension,
    useDelete: useDeleteExtension,
    uploadLabel: "Uploader une extension (.zip)",
    emptyLabel: "Aucune extension dans la bibliotheque.",
    detailType: "extension" as const,
    detailPrefix: "Extension",
    deleteConfirm: (item: OrgSkill | OrgExtension) =>
      `Supprimer l'extension "${item.name || item.id}" ?`,
  },
};

function LibraryTab({ type }: { type: LibraryType }) {
  const config = TAB_CONFIG[type];
  const { data: items, isLoading } = config.useList();
  const upload = config.useUpload();
  const remove = config.useDelete();
  const { isOrgAdmin } = useOrg();
  const fileRef = useRef<HTMLInputElement>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const handleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    upload.mutate(file, {
      onSuccess: () => {
        if (fileRef.current) fileRef.current.value = "";
      },
      onError: (err) => alert(`Erreur : ${err.message}`),
    });
  };

  const handleDelete = (item: OrgSkill | OrgExtension) => {
    if (!confirm(config.deleteConfirm(item))) return;
    remove.mutate(item.id, {
      onError: (err: Error) => alert(`Erreur : ${err.message}`),
    });
  };

  if (isLoading) {
    return (
      <div className="empty-state">
        <Spinner />
      </div>
    );
  }

  return (
    <>
      {isOrgAdmin && (
        <div className="library-upload">
          <label className="btn-upload">
            {upload.isPending ? <Spinner /> : config.uploadLabel}
            <input
              ref={fileRef}
              type="file"
              accept=".zip"
              onChange={handleUpload}
              style={{ display: "none" }}
              disabled={upload.isPending}
            />
          </label>
        </div>
      )}

      {!items || items.length === 0 ? (
        <div className="empty-state">
          <p>{config.emptyLabel}</p>
        </div>
      ) : (
        <div className="library-table-wrap">
          <table className="library-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Nom</th>
                <th>Uploade par</th>
                <th>Date</th>
                <th>Flows</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td className="cell-id">
                    <code>{item.id}</code>
                  </td>
                  <td className="cell-meta">
                    <div className="cell-name">{item.name || "-"}</div>
                    {item.description && <div className="cell-desc">{item.description}</div>}
                  </td>
                  <td>{item.createdByName || "-"}</td>
                  <td>{formatDate(item.createdAt)}</td>
                  <td className="cell-count">{item.usedByFlows ?? 0}</td>
                  <td className="cell-actions">
                    <button type="button" className="btn-sm" onClick={() => setSelectedId(item.id)}>
                      Voir
                    </button>
                    {isOrgAdmin && (
                      <button
                        type="button"
                        className="btn-sm btn-danger"
                        onClick={() => handleDelete(item)}
                        disabled={remove.isPending || (item.usedByFlows ?? 0) > 0}
                        title={
                          (item.usedByFlows ?? 0) > 0
                            ? `Utilise par ${item.usedByFlows} flow(s)`
                            : "Supprimer"
                        }
                      >
                        Supprimer
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={!!selectedId}
        onClose={() => setSelectedId(null)}
        title={`${config.detailPrefix} : ${selectedId ?? ""}`}
      >
        {selectedId && <LibraryItemDetail type={config.detailType} itemId={selectedId} />}
      </Modal>
    </>
  );
}

export function LibraryPage() {
  const [tab, setTab] = useState<LibraryType>("skills");

  return (
    <div className="library-page">
      <div className="page-header">
        <h2>Bibliotheque</h2>
      </div>

      <div className="exec-tabs">
        <button
          className={`tab ${tab === "skills" ? "active" : ""}`}
          onClick={() => setTab("skills")}
        >
          Skills
        </button>
        <button
          className={`tab ${tab === "extensions" ? "active" : ""}`}
          onClick={() => setTab("extensions")}
        >
          Extensions
        </button>
      </div>

      <LibraryTab key={tab} type={tab} />
    </div>
  );
}
