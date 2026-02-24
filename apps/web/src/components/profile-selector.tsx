import { useTranslation } from "react-i18next";
import { useConnectionProfiles } from "../hooks/use-connection-profiles";
import { useCurrentProfileId, setCurrentProfileId } from "../hooks/use-current-profile";

export function ProfileSelector() {
  const { t } = useTranslation("settings");
  const { data: profiles } = useConnectionProfiles();
  const currentProfileId = useCurrentProfileId();

  // Hide when only 1 profile exists
  if (!profiles || profiles.length <= 1) return null;

  return (
    <div className="profile-selector">
      <label>{t("profiles.selectorLabel")}</label>
      <select
        className="profile-select"
        value={currentProfileId ?? ""}
        onChange={(e) => setCurrentProfileId(e.target.value || null)}
      >
        {profiles.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
            {p.isDefault ? ` (${t("profiles.default")})` : ""}
          </option>
        ))}
      </select>
    </div>
  );
}
