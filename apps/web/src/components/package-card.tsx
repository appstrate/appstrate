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
    <Link
      className="block rounded-lg border border-border bg-card p-4 transition-colors hover:border-foreground/20 hover:bg-accent/50"
      to={href}
    >
      <div className="flex items-start justify-between gap-2">
        <h2 className="text-sm font-medium text-foreground">{displayName}</h2>
        <div className="flex items-center gap-1.5 shrink-0">
          <TypeBadge type={type} />
          {source === "built-in" && (
            <span className="text-[0.65rem] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-medium uppercase">
              {t("list.badgeBuiltIn")}
            </span>
          )}
          {type === "flow" && !!runningExecutions && runningExecutions > 0 && (
            <span className="text-[0.7rem] px-2 py-0.5 rounded bg-primary/15 text-primary inline-flex items-center gap-1.5">
              <Spinner /> {t("list.running", { count: runningExecutions })}
            </span>
          )}
        </div>
      </div>
      <p className="mt-1 text-xs text-muted-foreground line-clamp-2">{description || ""}</p>
      <div className="mt-2 flex flex-wrap gap-1">
        {type === "flow" &&
          tags?.map((tag) => (
            <span
              key={tag}
              className="text-[0.7rem] px-2 py-0.5 rounded-full bg-background text-muted-foreground border border-border"
            >
              {tag}
            </span>
          ))}
        {type !== "flow" && usedByFlows !== undefined && usedByFlows > 0 && (
          <span className="text-[0.7rem] px-2 py-0.5 rounded-full bg-background text-muted-foreground border border-border">
            {t("list.usedByFlows", { count: usedByFlows, ns: "flows" })}
          </span>
        )}
      </div>
    </Link>
  );
}
