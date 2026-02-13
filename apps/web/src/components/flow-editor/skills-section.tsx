export interface SkillEntry {
  id: string;
  description: string;
  content: string;
}

interface SkillsSectionProps {
  value: SkillEntry[];
  onChange: (value: SkillEntry[]) => void;
}

export function SkillsSection({ value, onChange }: SkillsSectionProps) {
  const add = () => {
    onChange([...value, { id: "", description: "", content: "" }]);
  };

  const update = (index: number, patch: Partial<SkillEntry>) => {
    const next = value.map((s, i) => (i === index ? { ...s, ...patch } : s));
    onChange(next);
  };

  const remove = (index: number) => {
    onChange(value.filter((_, i) => i !== index));
  };

  return (
    <div className="editor-section">
      <div className="editor-section-header">Skills</div>
      <div className="editor-section-body">
        {value.map((skill, i) => (
          <div key={i} className="skill-card">
            <div className="skill-card-header">
              <input
                type="text"
                placeholder="id (slug)"
                value={skill.id}
                onChange={(e) => update(i, { id: e.target.value })}
              />
              <button type="button" className="btn-remove" onClick={() => remove(i)}>
                &times;
              </button>
            </div>
            <input
              type="text"
              placeholder="description"
              value={skill.description}
              onChange={(e) => update(i, { description: e.target.value })}
            />
            <textarea
              className="skill-content"
              placeholder="Contenu du skill (markdown)..."
              value={skill.content}
              onChange={(e) => update(i, { content: e.target.value })}
            />
          </div>
        ))}
        <button type="button" className="add-field-btn" onClick={add}>
          + Ajouter un skill
        </button>
      </div>
    </div>
  );
}
