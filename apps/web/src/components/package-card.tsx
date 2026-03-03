import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { TypeBadge } from "./type-badge";
import { Spinner } from "./spinner";

interface PackageCardProps {
  id: string;
  displayName: string;
  description?: string | null;
  type: "flow" | "skill" | "extension";
  source?: "built-in" | "local";
  // Flow-specific
  runningExecutions?: number;
  tags?: string[];
  // Skill/Extension-specific
  usedByFlows?: number;
}

export function PackageCard({
  id,
  displayName,
  description,
  type,
  source,
  runningExecutions,
  tags,
  usedByFlows,
}: PackageCardProps) {
  const { t } = useTranslation(["flows", "settings", "common"]);
  const PREFIX = { flow: "flows", skill: "skills", extension: "extensions" } as const;
  const href = `/${PREFIX[type]}/${id}`;

  return (
    <Link className="flow-card" to={href}>
      <div className="flow-card-header">
        <h2>{displayName}</h2>
        <div className="flow-card-badges">
          <TypeBadge type={type} />
          {source === "built-in" && <span className="source-badge">{t("list.badgeBuiltIn")}</span>}
          {type === "flow" && !!runningExecutions && runningExecutions > 0 && (
            <span className="running-badge">
              <Spinner /> {t("list.running", { count: runningExecutions })}
            </span>
          )}
        </div>
      </div>
      <p className="description">{description || ""}</p>
      <div className="tags">
        {type === "flow" &&
          tags?.map((tag) => (
            <span key={tag} className="tag">
              {tag}
            </span>
          ))}
        {type !== "flow" && usedByFlows !== undefined && usedByFlows > 0 && (
          <span className="tag">{t("list.usedByFlows", { count: usedByFlows, ns: "flows" })}</span>
        )}
      </div>
    </Link>
  );
}
