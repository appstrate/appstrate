// SPDX-License-Identifier: Apache-2.0

import { useState, useEffect, useRef } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useWatch } from "react-hook-form";
import { useAppForm } from "../../hooks/use-app-form";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
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
  const displayName = user.name || user.email.split("@")[0]!;
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
  const [slugOpen, setSlugOpen] = useState(false);
  const nameValue = useWatch({ control, name: "name" });
  const slugValue = useWatch({ control, name: "slug" });

  // Pre-fill form for first org once user data is available.
  // The suggested slug intentionally differs from toSlug(name) (e.g. "pierre" vs
  // "pierres-organization"), so name→slug sync is driven by the name field's
  // onChange — not a useEffect watcher that would clobber the suggestion.
  const defaultAppliedRef = useRef(false);
  useEffect(() => {
    if (defaultAppliedRef.current) return;
    const isFirstOrg = !fromSwitcher && orgs.length === 0;
    if (!isFirstOrg || !user) return;
    defaultAppliedRef.current = true;
    reset(suggestOrgDefaults(user, i18n.language));
  }, [fromSwitcher, orgs, user, i18n.language, reset]);

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
      if (err.message.toLowerCase().includes("slug")) {
        setSlugOpen(true);
        setError("slug", { message: err.message });
      } else {
        setError("root", { message: err.message });
      }
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
                onChange: (e) => {
                  if (!slugEdited) setValue("slug", toSlug(e.target.value));
                },
              })}
              placeholder={t("createOrg.namePlaceholder")}
              autoFocus
              autoComplete="organization"
              aria-invalid={showError("name") ? true : undefined}
              className={cn(showError("name") && "border-destructive")}
            />
            {showError("name") && (
              <div className="text-destructive text-sm">{errors.name?.message}</div>
            )}
          </div>

          <div className="grid gap-2">
            {slugOpen ? (
              <>
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
                  autoFocus
                  aria-invalid={showError("slug") ? true : undefined}
                  className={cn(showError("slug") && "border-destructive")}
                />
                <div className="text-muted-foreground text-sm">{t("createOrg.slugHint")}</div>
                {showError("slug") && (
                  <div className="text-destructive text-sm">{errors.slug?.message}</div>
                )}
              </>
            ) : (
              <div className="text-muted-foreground flex items-center gap-2 text-sm">
                <span>
                  {t("createOrg.slugLabel")}{" "}
                  <span className="text-foreground font-medium">{slugValue || "—"}</span>
                </span>
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto p-0"
                  onClick={() => setSlugOpen(true)}
                >
                  {t("createOrg.slugEdit")}
                </Button>
              </div>
            )}
          </div>

          {errors.root && <p className="text-destructive text-sm">{errors.root.message}</p>}
        </div>
      </form>
    </OnboardingLayout>
  );
}
