import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useConnectionProfiles,
  useAppProfiles,
  useMyApplicationProfile,
  useSetMyApplicationProfile,
} from "../hooks/use-connection-profiles";
import { useApplications } from "../hooks/use-applications";
import { useCurrentApplicationId } from "../hooks/use-current-application";

const NONE_VALUE = "__none__";

/**
 * Per-(member, application) sticky default connection profile picker.
 *
 * Rendered on `/preferences/profiles` above the user's profile list. Lets
 * the signed-in member pin one connection profile as their personal
 * default for the active application. The credential proxy's
 * `resolveProfileId` cascade consults this between the explicit per-run
 * override (`X-Connection-Profile-Id`) and the app's shared default.
 *
 * Hidden when no application context is set (orphaned member, mid-app
 * switch). Disabled when the user has no profiles yet — the empty-state
 * hint nudges them to the "New profile" flow below.
 */
export function MyApplicationProfileSection() {
  const { t } = useTranslation(["settings"]);
  const applicationId = useCurrentApplicationId();
  const { data: applications } = useApplications();
  const currentApp = useMemo(
    () => applications?.find((a) => a.id === applicationId),
    [applications, applicationId],
  );

  const { data: userProfiles } = useConnectionProfiles();
  const { data: appProfiles } = useAppProfiles();
  const { data: sticky } = useMyApplicationProfile();
  const setSticky = useSetMyApplicationProfile();

  if (!applicationId || !currentApp) return null;

  const stickyId = sticky?.connectionProfileId ?? null;

  const hasOptions = (userProfiles?.length ?? 0) + (appProfiles?.length ?? 0) > 0;

  const handleChange = (value: string) => {
    if (value === NONE_VALUE) {
      setSticky.mutate(null);
    } else {
      setSticky.mutate(value);
    }
  };

  return (
    <div className="border-border bg-card mb-4 rounded-lg border p-5">
      <div className="mb-1 text-sm font-medium">
        {t("profiles.myAppDefault.title", { appName: currentApp.name })}
      </div>
      <p className="text-muted-foreground mb-3 text-xs">{t("profiles.myAppDefault.hint")}</p>

      <Select
        value={stickyId ?? NONE_VALUE}
        onValueChange={handleChange}
        disabled={!hasOptions || setSticky.isPending}
      >
        <SelectTrigger className="w-full sm:max-w-md">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE_VALUE}>{t("profiles.myAppDefault.useAppDefault")}</SelectItem>

          {(userProfiles?.length ?? 0) > 0 && (
            <div className="text-muted-foreground px-2 pt-2 pb-1 text-[10px] font-semibold tracking-wide uppercase">
              {t("profiles.myAppDefault.groupMine")}
            </div>
          )}
          {userProfiles?.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.name}
            </SelectItem>
          ))}

          {(appProfiles?.length ?? 0) > 0 && (
            <div className="text-muted-foreground px-2 pt-2 pb-1 text-[10px] font-semibold tracking-wide uppercase">
              {t("profiles.myAppDefault.groupApp")}
            </div>
          )}
          {appProfiles?.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {!hasOptions && (
        <p className="text-muted-foreground mt-2 text-xs">{t("profiles.myAppDefault.empty")}</p>
      )}
    </div>
  );
}
