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

export function ProfileSelector() {
  const { t } = useTranslation("settings");
  const { data: profiles } = useConnectionProfiles();
  const currentProfileId = useCurrentProfileId();

  // Hide when only 1 profile exists
  if (!profiles || profiles.length <= 1) return null;

  return (
    <div className="profile-selector flex items-center gap-2">
      <Label>{t("profiles.selectorLabel")}</Label>
      <Select
        value={currentProfileId ?? ""}
        onValueChange={(value) => setCurrentProfileId(value || null)}
      >
        <SelectTrigger className="w-[200px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
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
