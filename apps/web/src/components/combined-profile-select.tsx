// SPDX-License-Identifier: Apache-2.0

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Building2, User } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useConnectionProfiles, useAppProfiles } from "../hooks/use-connection-profiles";
import { PROFILE_ALL_VALUE, encodeProfileValue, decodeProfileValue } from "@/lib/profile-selection";

export interface ForeignProfile {
  id: string;
  name: string;
  ownerName: string;
}

interface CombinedProfileSelectProps {
  /** Current value */
  value: string | null;
  /** Change callback (null = "all" selected) */
  onChange: (connectionProfileId: string | null) => void;
  /** Show "All" as first option */
  showAllOption?: boolean;
  /** Trigger className override */
  triggerClassName?: string;
  /** ID for form association */
  id?: string;
  /** A profile owned by another user — shown as disabled, selectable only if currently active */
  foreignProfile?: ForeignProfile;
}

export function CombinedProfileSelect({
  value,
  onChange,
  showAllOption,
  triggerClassName = "w-[200px]",
  id,
  foreignProfile,
}: CombinedProfileSelectProps) {
  const { t } = useTranslation(["settings", "agents"]);
  const { data: userProfiles } = useConnectionProfiles();
  const { data: appProfiles } = useAppProfiles();

  const hasUserProfiles = (userProfiles?.length ?? 0) > 0;
  const hasAppProfiles = (appProfiles?.length ?? 0) > 0;

  // Determine if the foreign profile should be shown (value matches and not in own/org lists)
  const showForeign = useMemo(() => {
    if (!foreignProfile) return false;
    const inUser = userProfiles?.some((p) => p.id === foreignProfile.id) ?? false;
    const inApp = appProfiles?.some((p) => p.id === foreignProfile.id) ?? false;
    return !inUser && !inApp;
  }, [foreignProfile, userProfiles, appProfiles]);

  const hasMeaningfulChoice = hasUserProfiles || hasAppProfiles || showForeign;

  // Hide when no meaningful choice
  if (!hasMeaningfulChoice) return null;
  if (!showAllOption && !hasAppProfiles && !showForeign && (userProfiles?.length ?? 0) <= 1)
    return null;

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
        {showForeign && foreignProfile && (
          <SelectGroup>
            <div
              className="text-muted-foreground flex items-center gap-1 px-2 py-1.5 text-xs font-medium"
              role="presentation"
            >
              <User className="size-3" />
              {foreignProfile.ownerName}
            </div>
            <SelectItem
              key={foreignProfile.id}
              value={foreignProfile.id}
              disabled={value !== foreignProfile.id}
            >
              {foreignProfile.name}
            </SelectItem>
          </SelectGroup>
        )}
        {userProfiles?.map((p) => (
          <SelectItem key={p.id} value={p.id}>
            {p.name}
            {p.isDefault ? ` (${t("profiles.default")})` : ""}
          </SelectItem>
        ))}
        {hasAppProfiles && (
          <SelectGroup>
            <div
              className="text-muted-foreground flex items-center gap-1 px-2 py-1.5 text-xs font-medium"
              role="presentation"
            >
              <Building2 className="size-3" />
              {t("schedule.appProfiles", { ns: "agents" })}
            </div>
            {appProfiles?.map((p) => (
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
