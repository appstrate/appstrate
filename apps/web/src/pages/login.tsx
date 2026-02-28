import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../hooks/use-auth";

export function LoginPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { login, signup } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      if (mode === "login") {
        await login(email, password);
      } else {
        await signup(email, password, displayName || undefined);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("login.error"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-logo">
          <img src="/logo.svg" alt="Appstrate" className="app-logo" />
        </div>
        <form onSubmit={handleSubmit}>
          {mode === "signup" && (
            <div className="form-group">
              <label htmlFor="displayName">{t("login.name")}</label>
              <input
                id="displayName"
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder={t("login.namePlaceholder")}
                autoComplete="name"
              />
            </div>
          )}
          <div className="form-group">
            <label htmlFor="email">{t("login.email")}</label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="email@example.com"
              required
              autoComplete="email"
            />
          </div>
          <div className="form-group">
            <label htmlFor="password">{t("login.password")}</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
              minLength={6}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
            />
          </div>
          {error && <p className="form-error">{error}</p>}
          <button className="primary login-btn" type="submit" disabled={loading}>
            {loading ? t("loading") : mode === "login" ? t("login.login") : t("login.signup")}
          </button>
        </form>
        <p className="login-switch">
          {mode === "login" ? (
            <>
              {t("login.noAccount")}{" "}
              <button type="button" className="link-btn" onClick={() => setMode("signup")}>
                {t("login.signup")}
              </button>
            </>
          ) : (
            <>
              {t("login.hasAccount")}{" "}
              <button type="button" className="link-btn" onClick={() => setMode("login")}>
                {t("login.login")}
              </button>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
