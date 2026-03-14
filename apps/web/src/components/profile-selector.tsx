import { useTranslation } from "react-i18next";
import { useConnectionProfiles } from "../hooks/use-connection-profiles";
import { useCurrentProfileId, setCurrentProfileId } from "../hooks/use-current-profile";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";

const ALL_VALUE = "__all__";

interface ProfileSelectorProps {
  /** Show "All" as first option */
  showAllOption?: boolean;
  /** Controlled mode: current value (null = "all") */
  value?: string | null;
  /** Controlled mode: callback (null = "all" selected) */
  onChange?: (profileId: string | null) => void;
}

export function ProfileSelector({ showAllOption, value, onChange }: ProfileSelectorProps) {
  const { t } = useTranslation("settings");
  const { data: profiles } = useConnectionProfiles();
  const globalProfileId = useCurrentProfileId();

  const isControlled = value !== undefined && onChange !== undefined;

  // Hide when only 1 profile exists
  if (!profiles || profiles.length <= 1) return null;

  const selectValue = isControlled ? (value === null ? ALL_VALUE : value) : (globalProfileId ?? "");

  const handleChange = (val: string) => {
    if (isControlled) {
      onChange(val === ALL_VALUE ? null : val);
    } else {
      setCurrentProfileId(val || null);
    }
  };

  return (
    <div className="profile-selector flex items-center gap-2">
      <Label>{t("profiles.selectorLabel")}</Label>
      <Select value={selectValue} onValueChange={handleChange}>
        <SelectTrigger className="w-[200px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {showAllOption && <SelectItem value={ALL_VALUE}>{t("profiles.all")}</SelectItem>}
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
