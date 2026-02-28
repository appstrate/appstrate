import { useState, useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { orgStore } from "../stores/org-store";
import { Spinner } from "../components/spinner";
import { useFormErrors } from "../hooks/use-form-errors";

export function WelcomePage() {
  const { t } = useTranslation(["settings", "common"]);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const orgId = searchParams.get("org");

  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const rules = useMemo(
    () => ({
      password: (v: string) => {
        if (v && v.length < 8) return t("validation.minLength", { ns: "common", min: 8 });
        return undefined;
      },
      confirmPassword: (v: string) => {
        if (password && v !== password) return t("validation.passwordMismatch", { ns: "common" });
        return undefined;
      },
    }),
    [t, password],
  );

  const { errors, onBlur, validateAll, clearField } = useFormErrors(rules);

  const finishAndRedirect = () => {
    if (orgId) {
      orgStore.getState().setId(orgId);
    }
    navigate("/");
    window.location.reload();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setServerError(null);

    if (!validateAll({ password, confirmPassword })) return;

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
      setServerError(err instanceof Error ? err.message : "Erreur");
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
              onChange={(e) => {
                setPassword(e.target.value);
                clearField("password");
              }}
              onBlur={() => onBlur("password", password)}
              placeholder="••••••••"
              minLength={8}
              autoComplete="new-password"
              aria-invalid={errors.password ? true : undefined}
              className={errors.password ? "input-error" : undefined}
            />
            {errors.password && <div className="field-error">{errors.password}</div>}
          </div>

          {password && (
            <div className="form-group">
              <label htmlFor="confirmPassword">{t("preferences.confirmPassword")}</label>
              <input
                id="confirmPassword"
                type="password"
                value={confirmPassword}
                onChange={(e) => {
                  setConfirmPassword(e.target.value);
                  clearField("confirmPassword");
                }}
                onBlur={() => onBlur("confirmPassword", confirmPassword)}
                placeholder="••••••••"
                minLength={8}
                autoComplete="new-password"
                aria-invalid={errors.confirmPassword ? true : undefined}
                className={errors.confirmPassword ? "input-error" : undefined}
              />
              {errors.confirmPassword && (
                <div className="field-error">{errors.confirmPassword}</div>
              )}
            </div>
          )}

          {serverError && <p className="form-error">{serverError}</p>}

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
