import { FormField } from "../form-field";

interface MetadataState {
  name: string;
  displayName: string;
  description: string;
  author: string;
  tags: string[];
}

interface MetadataSectionProps {
  value: MetadataState;
  onChange: (value: MetadataState) => void;
  isEdit: boolean;
}

export function MetadataSection({ value, onChange, isEdit }: MetadataSectionProps) {
  const update = (patch: Partial<MetadataState>) => onChange({ ...value, ...patch });

  const handleTagInput = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      const input = e.currentTarget;
      const tag = input.value.trim().replace(/,$/g, "");
      if (tag && !value.tags.includes(tag)) {
        update({ tags: [...value.tags, tag] });
      }
      input.value = "";
    }
  };

  const removeTag = (tag: string) => {
    update({ tags: value.tags.filter((t) => t !== tag) });
  };

  return (
    <div className="editor-section">
      <div className="editor-section-header">Metadata</div>
      <div className="editor-section-body">
        <FormField
          id="meta-name"
          label="Identifiant (slug)"
          required
          value={value.name}
          onChange={(v) => update({ name: v.toLowerCase().replace(/[^a-z0-9-]/g, "-") })}
          placeholder="mon-flow"
          description={
            isEdit ? "Non modifiable apres creation" : "Identifiant unique du flow (kebab-case)"
          }
        />
        {isEdit && <input type="hidden" value={value.name} />}
        <FormField
          id="meta-displayName"
          label="Nom d'affichage"
          required
          value={value.displayName}
          onChange={(v) => update({ displayName: v })}
          placeholder="Mon Flow"
        />
        <div className="form-group">
          <label htmlFor="meta-description">Description *</label>
          <textarea
            id="meta-description"
            value={value.description}
            onChange={(e) => update({ description: e.target.value })}
            placeholder="Description du flow..."
          />
        </div>
        <FormField
          id="meta-author"
          label="Auteur"
          value={value.author}
          onChange={(v) => update({ author: v })}
          placeholder="Votre nom"
        />
        <div className="form-group">
          <label>Tags</label>
          <div className="tag-chips">
            {value.tags.map((tag) => (
              <span key={tag} className="tag-chip">
                {tag}
                <button type="button" className="btn-remove-inline" onClick={() => removeTag(tag)}>
                  &times;
                </button>
              </span>
            ))}
          </div>
          <input
            type="text"
            placeholder="Ajouter un tag (Entree ou virgule)"
            onKeyDown={handleTagInput}
          />
        </div>
      </div>
    </div>
  );
}
