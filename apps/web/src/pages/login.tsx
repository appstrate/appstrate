import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../hooks/use-auth";
import { useFormErrors } from "../hooks/use-form-errors";

export function LoginPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { login, signup } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [serverError, setServerError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const rules = useMemo(
    () => ({
      email: (v: string) => {
        if (!v.trim()) return t("validation.required", { ns: "common" });
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))
          return t("validation.emailFormat", { ns: "common" });
        return undefined;
      },
      password: (v: string) => {
        if (!v) return t("validation.required", { ns: "common" });
        if (v.length < 6) return t("validation.minLength", { ns: "common", min: 6 });
        return undefined;
      },
      displayName: (v: string) => {
        if (mode === "signup" && !v.trim()) return t("validation.required", { ns: "common" });
        return undefined;
      },
    }),
    [t, mode],
  );

  const { errors, onBlur, validateAll, clearErrors, clearField } = useFormErrors(rules);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setServerError(null);

    if (!validateAll({ email, password, displayName })) return;

    setLoading(true);
    try {
      if (mode === "login") {
        await login(email, password);
      } else {
        await signup(email, password, displayName || undefined);
      }
    } catch (err) {
      setServerError(err instanceof Error ? err.message : t("login.error"));
    } finally {
      setLoading(false);
    }
  };

  const switchMode = (newMode: "login" | "signup") => {
    setMode(newMode);
    setServerError(null);
    clearErrors();
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
                onChange={(e) => {
                  setDisplayName(e.target.value);
                  clearField("displayName");
                }}
                onBlur={() => onBlur("displayName", displayName)}
                placeholder={t("login.namePlaceholder")}
                autoComplete="name"
                aria-invalid={errors.displayName ? true : undefined}
                className={errors.displayName ? "input-error" : undefined}
              />
              {errors.displayName && <div className="field-error">{errors.displayName}</div>}
            </div>
          )}
          <div className="form-group">
            <label htmlFor="email">{t("login.email")}</label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                clearField("email");
              }}
              onBlur={() => onBlur("email", email)}
              placeholder="email@example.com"
              autoComplete="email"
              aria-invalid={errors.email ? true : undefined}
              className={errors.email ? "input-error" : undefined}
            />
            {errors.email && <div className="field-error">{errors.email}</div>}
          </div>
          <div className="form-group">
            <label htmlFor="password">{t("login.password")}</label>
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
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              aria-invalid={errors.password ? true : undefined}
              className={errors.password ? "input-error" : undefined}
            />
            {errors.password && <div className="field-error">{errors.password}</div>}
          </div>
          {serverError && <p className="form-error">{serverError}</p>}
          <button className="primary login-btn" type="submit" disabled={loading}>
            {loading ? t("loading") : mode === "login" ? t("login.login") : t("login.signup")}
          </button>
        </form>
        <p className="login-switch">
          {mode === "login" ? (
            <>
              {t("login.noAccount")}{" "}
              <button type="button" className="link-btn" onClick={() => switchMode("signup")}>
                {t("login.signup")}
              </button>
            </>
          ) : (
            <>
              {t("login.hasAccount")}{" "}
              <button type="button" className="link-btn" onClick={() => switchMode("login")}>
                {t("login.login")}
              </button>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
