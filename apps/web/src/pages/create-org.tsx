import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useOrg } from "../hooks/use-org";
import { toSlug, toLiveSlug } from "../lib/strings";

export function CreateOrgPage() {
  const { t } = useTranslation(["settings", "common"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { switchOrg } = useOrg();

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleNameChange = (value: string) => {
    setName(value);
    if (!slugEdited) {
      setSlug(toSlug(value));
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
      setError(err.message);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const trimmedName = name.trim();
    const trimmedSlug = slug.trim();

    if (!trimmedName) {
      setError(t("createOrg.errorName"));
      return;
    }
    if (!trimmedSlug) {
      setError(t("createOrg.errorSlug"));
      return;
    }
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(trimmedSlug)) {
      setError(t("createOrg.errorSlugFormat"));
      return;
    }

    createMutation.mutate({ name: trimmedName, slug: trimmedSlug });
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
              placeholder={t("createOrg.namePlaceholder")}
              required
              autoFocus
              autoComplete="organization"
            />
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
              }}
              onBlur={() => setSlug(toSlug(slug))}
              placeholder={t("createOrg.slugPlaceholder")}
              required
            />
            <div className="hint">{t("createOrg.slugHint")}</div>
          </div>
          {error && <p className="form-error">{error}</p>}
          <button className="primary login-btn" type="submit" disabled={createMutation.isPending}>
            {createMutation.isPending ? t("createOrg.creating") : t("createOrg.submit")}
          </button>
        </form>
        <p className="login-switch">
          <button type="button" className="link-btn" onClick={() => navigate("/")}>
            {t("btn.back")}
          </button>
        </p>
      </div>
    </div>
  );
}
