export interface ServiceEntry {
  id: string;
  provider: string;
  description: string;
  scopes: string;
}

interface ServicesSectionProps {
  value: ServiceEntry[];
  onChange: (value: ServiceEntry[]) => void;
}

export function ServicesSection({ value, onChange }: ServicesSectionProps) {
  const add = () => {
    onChange([...value, { id: "", provider: "", description: "", scopes: "" }]);
  };

  const update = (index: number, patch: Partial<ServiceEntry>) => {
    const next = value.map((s, i) => (i === index ? { ...s, ...patch } : s));
    onChange(next);
  };

  const remove = (index: number) => {
    onChange(value.filter((_, i) => i !== index));
  };

  return (
    <div className="editor-section">
      <div className="editor-section-header">Services requis</div>
      <div className="editor-section-body">
        {value.map((svc, i) => (
          <div key={i} className="field-row">
            <input
              type="text"
              placeholder="id (ex: gmail)"
              value={svc.id}
              onChange={(e) => update(i, { id: e.target.value })}
            />
            <input
              type="text"
              placeholder="provider (ex: google-mail)"
              value={svc.provider}
              onChange={(e) => update(i, { provider: e.target.value })}
            />
            <input
              type="text"
              placeholder="description"
              value={svc.description}
              onChange={(e) => update(i, { description: e.target.value })}
              className="field-row-grow"
            />
            <input
              type="text"
              placeholder="scopes (virgule)"
              value={svc.scopes}
              onChange={(e) => update(i, { scopes: e.target.value })}
            />
            <button type="button" className="btn-remove" onClick={() => remove(i)}>
              &times;
            </button>
          </div>
        ))}
        <button type="button" className="add-field-btn" onClick={add}>
          + Ajouter un service
        </button>
      </div>
    </div>
  );
}
