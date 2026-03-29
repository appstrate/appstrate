import { useTranslation } from "react-i18next";
import { Building2 } from "lucide-react";
import { useCurrentOrgProfileId, setCurrentOrgProfileId } from "../hooks/use-current-profile";
import { useOrgProfiles } from "../hooks/use-connection-profiles";
import type { OrgProfileWithBindings } from "../hooks/use-connection-profiles";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const NONE_VALUE = "__none__";

interface OrgProfileSelectorProps {
  /** Controlled mode: current value (null = none) */
  value?: string | null;
  /** Controlled mode: callback (null = none selected) */
  onChange?: (orgProfileId: string | null) => void;
  /** Provider IDs required by the current flow — used to show coverage count */
  flowProviderIds?: string[];
}

/** Count how many of the flow's providers are bound in this org profile. */
function coverageLabel(profile: OrgProfileWithBindings, flowProviderIds: string[]): string {
  const bound = profile.boundProviderIds ?? [];
  const covered = flowProviderIds.filter((id) => bound.includes(id)).length;
  return `${covered}/${flowProviderIds.length}`;
}

export function OrgProfileSelector({ value, onChange, flowProviderIds }: OrgProfileSelectorProps) {
  const { t } = useTranslation(["settings", "flows"]);
  const { data: orgProfiles } = useOrgProfiles();
  const globalOrgProfileId = useCurrentOrgProfileId();

  // Hide when no org profiles exist
  if (!orgProfiles || orgProfiles.length === 0) return null;

  const isControlled = value !== undefined && onChange !== undefined;
  const currentValue = isControlled ? (value ?? NONE_VALUE) : (globalOrgProfileId ?? NONE_VALUE);

  const handleChange = (val: string) => {
    const resolved = val === NONE_VALUE ? null : val;
    if (isControlled) onChange(resolved);
    else setCurrentOrgProfileId(resolved);
  };

  return (
    <div className="flex items-center gap-2">
      <Label className="text-xs text-muted-foreground shrink-0 inline-flex items-center gap-1">
        <Building2 className="size-3" />
        {t("schedule.orgProfiles", { ns: "flows", defaultValue: "Organization" })}
      </Label>
      <Select value={currentValue} onValueChange={handleChange}>
        <SelectTrigger className="w-[200px] h-8 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE_VALUE}>{t("profiles.none", { defaultValue: "None" })}</SelectItem>
          {orgProfiles.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              <span className="flex items-center gap-1.5">
                {p.name}
                {flowProviderIds && flowProviderIds.length > 0 && (
                  <span className="text-muted-foreground">
                    ({coverageLabel(p, flowProviderIds)})
                  </span>
                )}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
