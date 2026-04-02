// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Building2 } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useConnectionProfiles, useOrgProfiles } from "../hooks/use-connection-profiles";
import { PROFILE_ALL_VALUE, encodeProfileValue, decodeProfileValue } from "@/lib/profile-selection";

interface CombinedProfileSelectProps {
  /** Current value */
  value: string | null;
  /** Change callback (null = "all" selected) */
  onChange: (profileId: string | null) => void;
  /** Show "All" as first option */
  showAllOption?: boolean;
  /** Trigger className override */
  triggerClassName?: string;
  /** ID for form association */
  id?: string;
}

export function CombinedProfileSelect({
  value,
  onChange,
  showAllOption,
  triggerClassName = "w-[200px]",
  id,
}: CombinedProfileSelectProps) {
  const { t } = useTranslation(["settings", "flows"]);
  const { data: userProfiles } = useConnectionProfiles();
  const { data: orgProfiles } = useOrgProfiles();

  const hasUserProfiles = (userProfiles?.length ?? 0) > 0;
  const hasOrgProfiles = (orgProfiles?.length ?? 0) > 0;

  // Hide when no meaningful choice
  if (!hasUserProfiles && !hasOrgProfiles) return null;
  if (!showAllOption && !hasOrgProfiles && (userProfiles?.length ?? 0) <= 1) return null;

  const selectValue = encodeProfileValue(value);

  const handleChange = (val: string) => {
    onChange(decodeProfileValue(val));
  };

  return (
    <Select value={selectValue} onValueChange={handleChange}>
      <SelectTrigger className={triggerClassName} id={id}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {showAllOption && <SelectItem value={PROFILE_ALL_VALUE}>{t("profiles.all")}</SelectItem>}
        {userProfiles?.map((p) => (
          <SelectItem key={p.id} value={p.id}>
            {p.name}
            {p.isDefault ? ` (${t("profiles.default")})` : ""}
          </SelectItem>
        ))}
        {hasOrgProfiles && (
          <SelectGroup>
            <div
              className="text-muted-foreground flex items-center gap-1 px-2 py-1.5 text-xs font-medium"
              role="presentation"
            >
              <Building2 className="size-3" />
              {t("schedule.orgProfiles", { ns: "flows" })}
            </div>
            {orgProfiles?.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectGroup>
        )}
      </SelectContent>
    </Select>
  );
}
