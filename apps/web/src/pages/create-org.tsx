import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useOrg } from "../hooks/use-org";

function toSlug(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function CreateOrgPage() {
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
      setError("Le nom de l'organisation est requis.");
      return;
    }
    if (!trimmedSlug) {
      setError("Le slug est requis.");
      return;
    }
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(trimmedSlug)) {
      setError("Le slug ne doit contenir que des lettres minuscules, chiffres et tirets.");
      return;
    }

    createMutation.mutate({ name: trimmedName, slug: trimmedSlug });
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <h1 className="login-title">Nouvelle organisation</h1>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="org-name">Nom</label>
            <input
              id="org-name"
              type="text"
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder="Mon organisation"
              required
              autoFocus
              autoComplete="organization"
            />
          </div>
          <div className="form-group">
            <label htmlFor="org-slug">Slug</label>
            <input
              id="org-slug"
              type="text"
              value={slug}
              onChange={(e) => {
                setSlug(e.target.value);
                setSlugEdited(true);
              }}
              placeholder="mon-organisation"
              required
            />
            <div className="hint">
              Identifiant unique en minuscules (lettres, chiffres, tirets).
            </div>
          </div>
          {error && <p className="form-error">{error}</p>}
          <button
            className="primary login-btn"
            type="submit"
            disabled={createMutation.isPending}
          >
            {createMutation.isPending ? "Creation..." : "Creer l'organisation"}
          </button>
        </form>
        <p className="login-switch">
          <button type="button" className="link-btn" onClick={() => navigate("/")}>
            Retour
          </button>
        </p>
      </div>
    </div>
  );
}
