import { useTranslation } from "react-i18next";
import { useCurrentProfileId, setCurrentProfileId } from "../hooks/use-current-profile";
import { Label } from "@/components/ui/label";
import { CombinedProfileSelect } from "./combined-profile-select";

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
  const globalProfileId = useCurrentProfileId();

  const isControlled = value !== undefined && onChange !== undefined;

  const currentValue = isControlled ? value : globalProfileId;
  const handleChange = isControlled ? onChange : setCurrentProfileId;

  return (
    <div className="profile-selector flex items-center gap-2">
      <Label>{t("profiles.selectorLabel")}</Label>
      <CombinedProfileSelect
        value={currentValue}
        onChange={handleChange}
        showAllOption={showAllOption}
      />
    </div>
  );
}
