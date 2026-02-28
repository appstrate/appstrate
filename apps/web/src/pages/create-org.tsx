import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
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
    <div className="login-page">
      <div className="login-card">
        <h1 className="login-title">{t("createOrg.title")}</h1>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="org-name">{t("createOrg.name")}</label>
            <input
              id="org-name"
              type="text"
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              onBlur={() => onBlur("name", name)}
              placeholder={t("createOrg.namePlaceholder")}
              autoFocus
              autoComplete="organization"
              aria-invalid={errors.name ? true : undefined}
              className={errors.name ? "input-error" : undefined}
            />
            {errors.name && <div className="field-error">{errors.name}</div>}
          </div>
          <div className="form-group">
            <label htmlFor="org-slug">{t("createOrg.slug")}</label>
            <input
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
              className={errors.slug ? "input-error" : undefined}
            />
            <div className="hint">{t("createOrg.slugHint")}</div>
            {errors.slug && <div className="field-error">{errors.slug}</div>}
          </div>
          {serverError && <p className="form-error">{serverError}</p>}
          <button className="primary login-btn" type="submit" disabled={createMutation.isPending}>
            {createMutation.isPending ? t("createOrg.creating") : t("createOrg.submit")}
          </button>
        </form>
        {orgs.length > 0 && (
          <p className="login-switch">
            <button type="button" className="link-btn" onClick={() => navigate("/")}>
              {t("btn.back")}
            </button>
          </p>
        )}
      </div>
    </div>
  );
}
