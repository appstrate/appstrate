import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { usePackageVersions, type VersionListItem } from "../hooks/use-packages";

interface VersionSelectorProps {
  packageId: string;
  currentVersion: string | undefined;
  type: "flow" | "skill" | "extension";
}

export function VersionSelector({ packageId, currentVersion, type }: VersionSelectorProps) {
  const { t } = useTranslation("flows");
  const navigate = useNavigate();
  const { data: versions } = usePackageVersions(type, packageId);
  const detailPath = type === "flow" ? `/flows/${packageId}` : `/${type}s/${packageId}`;

  if (!versions || versions.length === 0) return null;

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const selected = e.target.value;
    navigate(`${detailPath}/${selected}`);
  };

  return (
    <div className="version-selector">
      <label>{t("version.selector")}</label>
      <select className="profile-select" value={currentVersion ?? ""} onChange={handleChange}>
        {!currentVersion && (
          <option value="" disabled>
            {t("version.selector")}
          </option>
        )}
        {versions.map((v: VersionListItem) => (
          <option key={v.id} value={v.version}>
            {v.version}
            {v.yanked ? ` (${t("version.yanked")})` : ""}
          </option>
        ))}
      </select>
    </div>
  );
}
