import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Spinner } from "../components/spinner";

export function WelcomePage() {
  const { t } = useTranslation(["settings", "common"]);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const orgId = searchParams.get("org");

  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const finishAndRedirect = () => {
    if (orgId) {
      localStorage.setItem("appstrate_current_org", orgId);
    }
    navigate("/");
    window.location.reload();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password && password !== confirmPassword) {
      setError(t("preferences.passwordMismatch"));
      return;
    }

    if (password && password.length < 8) {
      setError(t("welcome.passwordMin"));
      return;
    }

    setLoading(true);

    try {
      const body: Record<string, string> = {};
      if (displayName.trim()) body.displayName = displayName.trim();
      if (password) body.password = password;

      if (Object.keys(body).length > 0) {
        const res = await fetch("/api/welcome/setup", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.message || "Erreur");
        }
      }

      finishAndRedirect();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur");
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <h1 className="login-title">
          <span>App</span>strate
        </h1>
        <p className="auth-subtitle">{t("welcome.subtitle")}</p>

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="displayName">{t("welcome.displayName")}</label>
            <input
              id="displayName"
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={t("login.namePlaceholder")}
              autoComplete="name"
              autoFocus
            />
          </div>

          <div className="form-group">
            <label htmlFor="password">
              {t("welcome.password")} <span className="label-hint">({t("welcome.optional")})</span>
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              minLength={8}
              autoComplete="new-password"
            />
          </div>

          {password && (
            <div className="form-group">
              <label htmlFor="confirmPassword">{t("preferences.confirmPassword")}</label>
              <input
                id="confirmPassword"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="••••••••"
                minLength={8}
                autoComplete="new-password"
              />
            </div>
          )}

          {error && <p className="form-error">{error}</p>}

          <button className="primary login-btn" type="submit" disabled={loading}>
            {loading ? <Spinner /> : t("welcome.save")}
          </button>
        </form>

        <p className="login-switch">
          <button type="button" className="link-btn" onClick={finishAndRedirect}>
            {t("welcome.skip")}
          </button>
        </p>
      </div>
    </div>
  );
}
