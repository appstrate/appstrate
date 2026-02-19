import { useOrgSkills, useOrgExtensions } from "../../hooks/use-library";
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
  const skillsQuery = useOrgSkills();
  const extensionsQuery = useOrgExtensions();

  const isLoading = type === "skills" ? skillsQuery.isLoading : extensionsQuery.isLoading;
  const items = type === "skills" ? skillsQuery.data : extensionsQuery.data;

  const toggle = (id: string) => {
    if (selectedIds.includes(id)) {
      onChange(selectedIds.filter((x) => x !== id));
    } else {
      onChange([...selectedIds, id]);
    }
  };

  return (
    <div className="editor-section">
      <div className="editor-section-header">{title}</div>
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
