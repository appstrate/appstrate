import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { PackageType } from "@appstrate/shared-types";
import { usePackageVersions, type VersionListItem } from "../hooks/use-packages";
import { packageDetailPath } from "../lib/package-paths";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface VersionSelectorProps {
  packageId: string;
  currentVersion: string | undefined;
  type: PackageType;
  hasDraftChanges?: boolean;
  currentIsDraft?: boolean;
}

export function VersionSelector({
  packageId,
  currentVersion,
  type,
  hasDraftChanges,
  currentIsDraft,
}: VersionSelectorProps) {
  const { t } = useTranslation("flows");
  const navigate = useNavigate();
  const { data: versions } = usePackageVersions(type, packageId);
  const detailPath = packageDetailPath(type, packageId);

  if (!versions || versions.length === 0) return null;

  const handleChange = (selected: string) => {
    if (selected === "draft") {
      navigate(detailPath);
    } else {
      navigate(`${detailPath}/${selected}`);
    }
  };

  const selectValue = currentIsDraft ? "draft" : (currentVersion ?? versions[0]?.version ?? "");

  return (
    <div className="version-selector flex items-center gap-2">
      <Select value={selectValue} onValueChange={handleChange}>
        <SelectTrigger className="w-[180px]">
          <SelectValue placeholder={t("version.selector")} />
        </SelectTrigger>
        <SelectContent>
          {hasDraftChanges && <SelectItem value="draft">{t("version.draftLabel")}</SelectItem>}
          {versions.map((v: VersionListItem) => (
            <SelectItem key={v.id} value={v.version}>
              {v.version}
              {v.yanked ? ` (${t("version.yanked")})` : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
