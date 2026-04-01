import { useTranslation } from "react-i18next";
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
  /** Current value (null = "all" when showAllOption is true) */
  value: string | null;
  /** Callback when profile changes */
  onChange: (profileId: string | null) => void;
  label?: string;
}

export function ProfileSelector({ showAllOption, value, onChange, label }: ProfileSelectorProps) {
  const { t } = useTranslation("settings");
  const { data: profiles } = useConnectionProfiles();

  if (!profiles || profiles.length <= 1) return null;

  const currentValue = value === null && showAllOption ? PROFILE_ALL_VALUE : (value ?? "");

  const handleChange = (val: string) => {
    onChange(decodeProfileValue(val));
  };

  return (
    <div className="flex items-center gap-2">
      <Label className="text-muted-foreground shrink-0 text-xs">
        {label ?? t("profiles.selectorLabel")}
      </Label>
      <Select value={currentValue} onValueChange={handleChange}>
        <SelectTrigger className="h-8 w-[180px] text-xs">
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
