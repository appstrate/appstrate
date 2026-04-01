import { useTranslation } from "react-i18next";
import { useCurrentProfileId, setCurrentProfileId } from "../hooks/use-current-profile";
import { useConnectionProfiles } from "../hooks/use-connection-profiles";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PROFILE_ALL_VALUE, decodeProfileValue } from "@/lib/profile-selection";

interface ProfileSelectorProps {
  /** Show "All" as first option */
  showAllOption?: boolean;
  /** Controlled mode: current value */
  value?: string | null;
  /** Controlled mode: callback */
  onChange?: (profileId: string | null) => void;
  label?: string;
}

export function ProfileSelector({ showAllOption, value, onChange, label }: ProfileSelectorProps) {
  const { t } = useTranslation("settings");
  const { data: profiles } = useConnectionProfiles();
  const globalProfileId = useCurrentProfileId();

  const isControlled = value !== undefined && onChange !== undefined;

  if (!profiles || profiles.length <= 1) return null;

  const currentValue = isControlled
    ? value === null && showAllOption
      ? PROFILE_ALL_VALUE
      : (value ?? "")
    : (globalProfileId ?? "");
  const handleChange = (val: string) => {
    const resolved = decodeProfileValue(val);
    if (isControlled) onChange(resolved);
    else setCurrentProfileId(resolved);
  };

  return (
    <div className="flex items-center gap-2">
      <Label className="text-xs text-muted-foreground shrink-0">
        {label ?? t("profiles.selectorLabel")}
      </Label>
      <Select value={currentValue} onValueChange={handleChange}>
        <SelectTrigger className="w-[180px] h-8 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {showAllOption && <SelectItem value={PROFILE_ALL_VALUE}>{t("profiles.all")}</SelectItem>}
          {profiles.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.name}
              {p.isDefault ? ` (${t("profiles.default")})` : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
