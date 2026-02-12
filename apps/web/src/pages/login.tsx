import { useState } from "react";
import { useAuth } from "../hooks/use-auth";

export function LoginPage() {
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
      setError(err instanceof Error ? err.message : "Une erreur est survenue");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <h1 className="login-title">
          <span>App</span>strate
        </h1>
        <form onSubmit={handleSubmit}>
          {mode === "signup" && (
            <div className="form-group">
              <label htmlFor="displayName">Nom</label>
              <input
                id="displayName"
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Votre nom"
                autoComplete="name"
              />
            </div>
          )}
          <div className="form-group">
            <label htmlFor="email">Email</label>
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
            <label htmlFor="password">Mot de passe</label>
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
            {loading ? "Chargement..." : mode === "login" ? "Se connecter" : "Creer un compte"}
          </button>
        </form>
        <p className="login-switch">
          {mode === "login" ? (
            <>
              Pas encore de compte ?{" "}
              <button type="button" className="link-btn" onClick={() => setMode("signup")}>
                Creer un compte
              </button>
            </>
          ) : (
            <>
              Deja un compte ?{" "}
              <button type="button" className="link-btn" onClick={() => setMode("login")}>
                Se connecter
              </button>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
