import { useState, useEffect, useRef } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useWatch } from "react-hook-form";
import { useAppForm } from "../../hooks/use-app-form";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "../../api";
import { useOrg } from "../../hooks/use-org";
import { useAuth } from "../../hooks/use-auth";
import { toSlug, toLiveSlug } from "../../lib/strings";
import { OnboardingLayout, useOnboardingNav } from "../../components/onboarding-layout";

function suggestOrgDefaults(
  user: { email: string; name?: string },
  language: string,
): { name: string; slug: string } {
  const displayName = user.name || user.email.split("@")[0];
  const name =
    language === "fr" ? `Organisation de ${displayName}` : `${displayName}'s Organization`;
  return { name, slug: toSlug(displayName) };
}

interface CreateOrgFormData {
  name: string;
  slug: string;
}

export function OnboardingCreateStep() {
  const { t, i18n } = useTranslation(["settings", "common"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { switchOrg, currentOrg, orgs, loading } = useOrg();
  const { user } = useAuth();
  const { nextRoute } = useOnboardingNav("create");

  const location = useLocation();
  const fromSwitcher = (location.state as { fromSwitcher?: boolean })?.fromSwitcher;

  // If org already created (back navigation), skip to next step
  // Use currentOrg (resolved from API) instead of raw localStorage orgId
  // to avoid redirect loops with stale IDs from deleted orgs
  // When arriving from the org switcher, let the user create a new org
  useEffect(() => {
    if (!loading && currentOrg && !fromSwitcher && nextRoute) {
      navigate(nextRoute, { replace: true });
    }
  }, [currentOrg, loading, navigate, fromSwitcher, nextRoute]);

  const {
    register,
    handleSubmit,
    control,
    setValue,
    reset,
    setError,
    showError,
    formState: { errors },
  } = useAppForm<CreateOrgFormData>({
    defaultValues: { name: "", slug: "" },
  });

  const [slugEdited, setSlugEdited] = useState(false);
  const nameValue = useWatch({ control, name: "name" });
  const slugValue = useWatch({ control, name: "slug" });

  // Pre-fill form for first org once user data is available.
  // reset() sets both fields atomically without triggering the name→slug watcher.
  // setSlugEdited is intentional here: one-shot init, not a cascading pattern.
  const defaultAppliedRef = useRef(false);
  useEffect(() => {
    if (defaultAppliedRef.current) return;
    const isFirstOrg = !fromSwitcher && orgs.length === 0;
    if (!isFirstOrg || !user) return;
    defaultAppliedRef.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot pre-fill, not cascading
    setSlugEdited(true);
    reset(suggestOrgDefaults(user, i18n.language));
  }, [fromSwitcher, orgs, user, i18n.language, reset]);

  useEffect(() => {
    if (!slugEdited) {
      setValue("slug", toSlug(nameValue));
    }
  }, [nameValue, slugEdited, setValue]);

  const createMutation = useMutation({
    mutationFn: async (body: { name: string; slug: string }) => {
      return api<{ id: string }>("/orgs", {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
    onSuccess: async (data) => {
      await queryClient.invalidateQueries({ queryKey: ["orgs"] });
      switchOrg(data.id);
      if (nextRoute) navigate(nextRoute);
    },
    onError: (err: Error) => {
      setError("root", { message: err.message });
    },
  });

  const onSubmit = (data: CreateOrgFormData) => {
    createMutation.mutate({ name: data.name.trim(), slug: data.slug.trim() });
  };

  return (
    <OnboardingLayout
      step="create"
      title={t("onboarding.createTitle")}
      subtitle={t("onboarding.createSubtitle")}
      onNext={handleSubmit(onSubmit)}
      nextDisabled={!nameValue.trim() || !slugValue.trim()}
      nextPending={createMutation.isPending}
      nextLabel={t("onboarding.createAction")}
    >
      <form onSubmit={handleSubmit(onSubmit)}>
        <div className="flex flex-col gap-4">
          <div className="grid gap-2">
            <Label htmlFor="org-name">{t("createOrg.name")}</Label>
            <Input
              id="org-name"
              type="text"
              {...register("name", {
                validate: (v) => {
                  if (!v.trim()) return t("validation.required", { ns: "common" });
                  return true;
                },
              })}
              placeholder={t("createOrg.namePlaceholder")}
              autoFocus
              autoComplete="organization"
              aria-invalid={showError("name") ? true : undefined}
              className={cn(showError("name") && "border-destructive")}
            />
            {showError("name") && (
              <div className="text-sm text-destructive">{errors.name?.message}</div>
            )}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="org-slug">{t("createOrg.slug")}</Label>
            <Input
              id="org-slug"
              type="text"
              {...register("slug", {
                validate: (v) => {
                  if (!v.trim()) return t("validation.required", { ns: "common" });
                  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(v.trim()))
                    return t("validation.slugFormat", { ns: "common" });
                  return true;
                },
                onChange: (e) => {
                  setSlugEdited(true);
                  setValue("slug", toLiveSlug(e.target.value));
                },
                onBlur: () => {
                  setValue("slug", toSlug(slugValue));
                },
              })}
              placeholder={t("createOrg.slugPlaceholder")}
              aria-invalid={showError("slug") ? true : undefined}
              className={cn(showError("slug") && "border-destructive")}
            />
            <div className="text-sm text-muted-foreground">{t("createOrg.slugHint")}</div>
            {showError("slug") && (
              <div className="text-sm text-destructive">{errors.slug?.message}</div>
            )}
          </div>

          {errors.root && <p className="text-sm text-destructive">{errors.root.message}</p>}
        </div>
      </form>
    </OnboardingLayout>
  );
}
