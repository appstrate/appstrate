import { type ChangeEvent, useRef } from "react";
import {
  useOrgSkills,
  useOrgExtensions,
  useUploadSkill,
  useUploadExtension,
} from "../../hooks/use-library";
import { Spinner } from "../spinner";

interface ResourceSectionProps {
  type: "skills" | "extensions";
  title: string;
  emptyLabel: string;
  selectedIds: string[];
  onChange: (ids: string[]) => void;
}

export function ResourceSection({
  type,
  title,
  emptyLabel,
  selectedIds,
  onChange,
}: ResourceSectionProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const skillsQuery = useOrgSkills();
  const extensionsQuery = useOrgExtensions();
  const uploadSkill = useUploadSkill();
  const uploadExtension = useUploadExtension();

  const isLoading = type === "skills" ? skillsQuery.isLoading : extensionsQuery.isLoading;
  const items = type === "skills" ? skillsQuery.data : extensionsQuery.data;
  const upload = type === "skills" ? uploadSkill : uploadExtension;

  const toggle = (id: string) => {
    if (selectedIds.includes(id)) {
      onChange(selectedIds.filter((x) => x !== id));
    } else {
      onChange([...selectedIds, id]);
    }
  };

  const handleUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const result = await upload.mutateAsync(file);
      const newId = type === "skills"
        ? (result as { skill: { id: string } }).skill.id
        : (result as { extension: { id: string } }).extension.id;

      if (!selectedIds.includes(newId)) {
        onChange([...selectedIds, newId]);
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : "Upload failed");
    }

    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  return (
    <div className="editor-section">
      <div className="editor-section-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        {title}
        <label className="btn-upload btn-upload-sm">
          {upload.isPending ? <Spinner /> : "Importer (.zip)"}
          <input type="file" accept=".zip" ref={fileInputRef} onChange={handleUpload} style={{ display: "none" }} disabled={upload.isPending} />
        </label>
      </div>
      <div className="editor-section-body">
        {isLoading ? (
          <div className="empty-state">
            <Spinner />
          </div>
        ) : !items || items.length === 0 ? (
          <p className="editor-hint">{emptyLabel}</p>
        ) : (
          <div className="library-checkbox-list">
            {items.map((item) => (
              <label
                key={item.id}
                className={`library-checkbox-item${selectedIds.includes(item.id) ? " checked" : ""}`}
              >
                <input
                  type="checkbox"
                  checked={selectedIds.includes(item.id)}
                  onChange={() => toggle(item.id)}
                />
                <div className="library-checkbox-info">
                  <span className="library-checkbox-name">{item.name || item.id}</span>
                  {item.description && (
                    <span className="library-checkbox-desc">{item.description}</span>
                  )}
                </div>
              </label>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
