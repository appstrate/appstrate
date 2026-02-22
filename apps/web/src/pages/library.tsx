import { useState, useRef } from "react";
import { useTranslation } from "react-i18next";
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

type LibraryType = "skills" | "extensions";

function getTabConfig(t: (key: string, opts?: Record<string, unknown>) => string) {
  return {
    skills: {
      useList: useOrgSkills,
      useUpload: useUploadSkill,
      useDelete: useDeleteSkill,
      uploadLabel: t("library.uploadSkill"),
      emptyLabel: t("library.emptySkill"),
      detailType: "skill" as const,
      detailPrefix: "Skill",
      deleteConfirm: (item: OrgSkill | OrgExtension) =>
        t("library.deleteSkill", { name: item.name || item.id }),
    },
    extensions: {
      useList: useOrgExtensions,
      useUpload: useUploadExtension,
      useDelete: useDeleteExtension,
      uploadLabel: t("library.uploadExtension"),
      emptyLabel: t("library.emptyExtension"),
      detailType: "extension" as const,
      detailPrefix: "Extension",
      deleteConfirm: (item: OrgSkill | OrgExtension) =>
        t("library.deleteExtension", { name: item.name || item.id }),
    },
  };
}

function LibraryTab({ type }: { type: LibraryType }) {
  const { t } = useTranslation(["settings", "common"]);
  const config = getTabConfig(t)[type];
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
      onError: (err) => alert(t("error.prefix", { message: err.message })),
    });
  };

  const handleDelete = (item: OrgSkill | OrgExtension) => {
    if (!confirm(config.deleteConfirm(item))) return;
    remove.mutate(item.id, {
      onError: (err: Error) => alert(t("error.prefix", { message: err.message })),
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
                <th>{t("library.colId")}</th>
                <th>{t("library.colName")}</th>
                <th>{t("library.colUploader")}</th>
                <th>{t("library.colFlows")}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td className="cell-id">
                    <code>{item.id}</code>
                    {item.source === "built-in" && (
                      <span className="badge badge-builtin">{t("library.builtIn")}</span>
                    )}
                  </td>
                  <td className="cell-meta">
                    <div className="cell-name">{item.name || "-"}</div>
                    {item.description && <div className="cell-desc">{item.description}</div>}
                  </td>
                  <td>{item.createdByName || "-"}</td>
                  <td className="cell-count">{item.usedByFlows ?? 0}</td>
                  <td className="cell-actions">
                    <button type="button" className="btn-sm" onClick={() => setSelectedId(item.id)}>
                      {t("btn.view")}
                    </button>
                    {isOrgAdmin && item.source !== "built-in" && (
                      <button
                        type="button"
                        className="btn-sm btn-danger"
                        onClick={() => handleDelete(item)}
                        disabled={remove.isPending || (item.usedByFlows ?? 0) > 0}
                        title={
                          (item.usedByFlows ?? 0) > 0
                            ? t("library.usedBy", { count: item.usedByFlows })
                            : t("btn.delete")
                        }
                      >
                        {t("btn.delete")}
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
        title={
          type === "skills"
            ? t("library.detailSkill", { id: selectedId ?? "" })
            : t("library.detailExtension", { id: selectedId ?? "" })
        }
      >
        {selectedId && <LibraryItemDetail type={config.detailType} itemId={selectedId} />}
      </Modal>
    </>
  );
}

export function LibraryPage() {
  const { t } = useTranslation(["settings", "common"]);
  const [tab, setTab] = useState<LibraryType>("skills");

  return (
    <div className="library-page">
      <div className="page-header">
        <h2>{t("library.title")}</h2>
      </div>

      <div className="exec-tabs">
        <button
          className={`tab ${tab === "skills" ? "active" : ""}`}
          onClick={() => setTab("skills")}
        >
          {t("library.tabSkills")}
        </button>
        <button
          className={`tab ${tab === "extensions" ? "active" : ""}`}
          onClick={() => setTab("extensions")}
        >
          {t("library.tabExtensions")}
        </button>
      </div>

      <LibraryTab key={tab} type={tab} />
    </div>
  );
}
