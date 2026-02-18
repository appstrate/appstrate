import { useServices } from "../../hooks/use-services";
import type { ServiceEntry } from "./types";

interface ServicePickerProps {
  value: ServiceEntry[];
  onChange: (value: ServiceEntry[]) => void;
}

export function ServicePicker({ value, onChange }: ServicePickerProps) {
  const { data: integrations, isLoading } = useServices();

  const update = (index: number, patch: Partial<ServiceEntry>) => {
    const next = value.map((s, i) => (i === index ? { ...s, ...patch } : s));
    onChange(next);
  };

  const remove = (index: number) => {
    onChange(value.filter((_, i) => i !== index));
  };

  const addFromIntegration = (uniqueKey: string, provider: string) => {
    const alreadySelected = value.some((s) => s.id === uniqueKey);
    if (alreadySelected) return;
    onChange([...value, { id: uniqueKey, provider, description: "", scopes: "", connectionMode: "user" }]);
  };

  const selectedIds = new Set(value.map((s) => s.id));

  return (
    <div>
      {/* Selected services */}
      {value.length > 0 && (
        <div className="service-picker-selected">
          <div className="section-title" style={{ marginBottom: "0.5rem" }}>
            Services selectionnes ({value.length})
          </div>
          {value.map((svc, i) => (
            <div key={i} className="service-picker-selected-card">
              <div className="service-picker-selected-header">
                {integrations?.find((ig) => ig.uniqueKey === svc.id)?.logo && (
                  <img
                    src={integrations.find((ig) => ig.uniqueKey === svc.id)!.logo}
                    alt=""
                    className="service-logo"
                  />
                )}
                <div className="service-picker-selected-info">
                  <strong>{svc.id}</strong>
                  <span className="service-provider">{svc.provider}</span>
                </div>
                <button type="button" className="btn-remove" onClick={() => remove(i)}>
                  &times;
                </button>
              </div>
              <div className="service-picker-selected-fields">
                <input
                  type="text"
                  placeholder="description"
                  value={svc.description}
                  onChange={(e) => update(i, { description: e.target.value })}
                />
                <input
                  type="text"
                  placeholder="scopes (virgule)"
                  value={svc.scopes}
                  onChange={(e) => update(i, { scopes: e.target.value })}
                />
                <select
                  value={svc.connectionMode}
                  onChange={(e) =>
                    update(i, { connectionMode: e.target.value as "user" | "admin" })
                  }
                >
                  <option value="user">User</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Available integrations from Nango */}
      <div className="section-title" style={{ marginTop: value.length > 0 ? "1rem" : 0 }}>
        Integrations disponibles
      </div>
      {isLoading ? (
        <div className="empty-state empty-state-compact">Chargement...</div>
      ) : !integrations || integrations.length === 0 ? (
        <div className="empty-state empty-state-compact">Aucune integration configuree</div>
      ) : (
        <div className="service-picker-grid">
          {integrations.map((ig) => {
            const isSelected = selectedIds.has(ig.uniqueKey);
            return (
              <button
                key={ig.uniqueKey}
                type="button"
                className={`service-picker-card${isSelected ? " selected" : ""}`}
                onClick={() => addFromIntegration(ig.uniqueKey, ig.provider)}
                disabled={isSelected}
              >
                {ig.logo && <img src={ig.logo} alt="" className="service-logo" />}
                <div className="service-picker-card-info">
                  <span className="service-picker-card-name">{ig.displayName}</span>
                  <span className="service-provider">{ig.provider}</span>
                </div>
                {ig.authMode && <span className="auth-mode-badge">{ig.authMode}</span>}
                {isSelected && <span className="service-picker-check">&#10003;</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
