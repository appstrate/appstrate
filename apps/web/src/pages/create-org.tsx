import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "../api";
import { useOrg } from "../hooks/use-org";
import { toSlug, toLiveSlug } from "../lib/strings";
import { useFormErrors } from "../hooks/use-form-errors";

export function CreateOrgPage() {
  const { t } = useTranslation(["settings", "common"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { orgs, switchOrg } = useOrg();

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const rules = useMemo(
    () => ({
      name: (v: string) => {
        if (!v.trim()) return t("validation.required", { ns: "common" });
        return undefined;
      },
      slug: (v: string) => {
        if (!v.trim()) return t("validation.required", { ns: "common" });
        if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(v.trim()))
          return t("validation.slugFormat", { ns: "common" });
        return undefined;
      },
    }),
    [t],
  );

  const { errors, onBlur, validateAll, clearField } = useFormErrors(rules);

  const handleNameChange = (value: string) => {
    setName(value);
    clearField("name");
    if (!slugEdited) {
      setSlug(toSlug(value));
      clearField("slug");
    }
  };

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
      navigate("/");
    },
    onError: (err: Error) => {
      setServerError(err.message);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setServerError(null);

    if (!validateAll({ name, slug })) return;

    createMutation.mutate({ name: name.trim(), slug: slug.trim() });
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm rounded-lg border border-border bg-card p-6 shadow-lg">
        <h1 className="text-2xl font-bold text-center mb-2">{t("createOrg.title")}</h1>
        <form onSubmit={handleSubmit}>
          <div className="space-y-2">
            <Label htmlFor="org-name">{t("createOrg.name")}</Label>
            <Input
              id="org-name"
              type="text"
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              onBlur={() => onBlur("name", name)}
              placeholder={t("createOrg.namePlaceholder")}
              autoFocus
              autoComplete="organization"
              aria-invalid={errors.name ? true : undefined}
              className={cn(errors.name && "border-destructive")}
            />
            {errors.name && <div className="text-sm text-destructive">{errors.name}</div>}
          </div>
          <div className="space-y-2">
            <Label htmlFor="org-slug">{t("createOrg.slug")}</Label>
            <Input
              id="org-slug"
              type="text"
              value={slug}
              onChange={(e) => {
                setSlug(toLiveSlug(e.target.value));
                setSlugEdited(true);
                clearField("slug");
              }}
              onBlur={() => {
                setSlug(toSlug(slug));
                onBlur("slug", slug);
              }}
              placeholder={t("createOrg.slugPlaceholder")}
              aria-invalid={errors.slug ? true : undefined}
              className={cn(errors.slug && "border-destructive")}
            />
            <div className="text-sm text-muted-foreground">{t("createOrg.slugHint")}</div>
            {errors.slug && <div className="text-sm text-destructive">{errors.slug}</div>}
          </div>
          {serverError && <p className="text-sm text-destructive">{serverError}</p>}
          <Button className="w-full mt-4" type="submit" disabled={createMutation.isPending}>
            {createMutation.isPending ? t("createOrg.creating") : t("createOrg.submit")}
          </Button>
        </form>
        {orgs.length > 0 && (
          <p className="text-center text-sm text-muted-foreground mt-4">
            <Button
              type="button"
              variant="link"
              className="h-auto p-0 text-sm"
              onClick={() => navigate("/")}
            >
              {t("btn.back")}
            </Button>
          </p>
        )}
      </div>
    </div>
  );
}
