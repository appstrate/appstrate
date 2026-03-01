export function TypeBadge({ type }: { type: "flow" | "skill" | "extension" }) {
  return <span className={`type-badge type-badge-${type}`}>{type}</span>;
}
