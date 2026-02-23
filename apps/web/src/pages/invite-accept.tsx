import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { refreshAuth } from "../hooks/use-auth";
import { Spinner } from "../components/spinner";

interface InviteInfo {
  email: string;
  orgName: string;
  role: string;
  inviterName: string;
  expiresAt: string;
}

export function InviteAcceptPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();

  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    fetch(`/invite/${token}/info`, { credentials: "include" })
      .then(async (res) => {
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || "INVITATION_NOT_FOUND");
        }
        return res.json();
      })
      .then((data: InviteInfo) => {
        setInfo(data);
        setLoading(false);
      })
      .catch((err) => {
        const code = err instanceof Error ? err.message : "INVITATION_NOT_FOUND";
        if (code === "INVITATION_EXPIRED") {
          setError(t("invite.expired"));
        } else if (code === "INVITATION_ACCEPTED") {
          setError(t("invite.alreadyAccepted"));
        } else if (code === "INVITATION_CANCELLED") {
          setError(t("invite.cancelled"));
        } else {
          setError(t("invite.invalid"));
        }
        setLoading(false);
      });
  }, [token, t]);

  const handleAccept = async () => {
    if (!token) return;
    setAccepting(true);
    setError(null);

    try {
      const res = await fetch(`/invite/${token}/accept`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || "Erreur");
      }

      const data = await res.json();

      if (data.isNewUser) {
        // New user — refresh auth state (session cookie was set by backend), then go to welcome
        localStorage.setItem("appstrate_current_org", data.orgId);
        await refreshAuth();
        navigate(`/welcome?org=${data.orgId}`);
      } else if (data.requiresLogin) {
        // Existing user but not logged in
        navigate("/");
      } else {
        // Existing user, already logged in — switch org and go home
        if (data.orgId) {
          localStorage.setItem("appstrate_current_org", data.orgId);
        }
        navigate("/");
        window.location.reload();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("invite.error"));
      setAccepting(false);
    }
  };

  if (loading) {
    return (
      <div className="login-page">
        <div className="login-card">
          <div className="empty-state">
            <Spinner />
          </div>
        </div>
      </div>
    );
  }

  if (error && !info) {
    return (
      <div className="login-page">
        <div className="login-card">
          <h1 className="login-title">
            <span>App</span>strate
          </h1>
          <p className="form-error" style={{ textAlign: "center", marginBottom: "1rem" }}>
            {error}
          </p>
          <button className="primary login-btn" onClick={() => navigate("/")}>
            {t("invite.goHome")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <h1 className="login-title">
          <span>App</span>strate
        </h1>
        <p
          style={{
            textAlign: "center",
            color: "var(--text-secondary)",
            marginBottom: "1.5rem",
            fontSize: "0.9rem",
            lineHeight: 1.5,
          }}
        >
          {t("invite.description", {
            inviter: info?.inviterName,
            org: info?.orgName,
          })}
        </p>

        <div
          style={{
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: "8px",
            padding: "1rem",
            marginBottom: "1.5rem",
          }}
        >
          <div
            style={{ fontSize: "0.8rem", color: "var(--text-secondary)", marginBottom: "0.25rem" }}
          >
            {t("invite.emailLabel")}
          </div>
          <div style={{ fontSize: "0.9rem" }}>{info?.email}</div>
          <div
            style={{
              fontSize: "0.8rem",
              color: "var(--text-secondary)",
              marginTop: "0.75rem",
              marginBottom: "0.25rem",
            }}
          >
            {t("invite.roleLabel")}
          </div>
          <div style={{ fontSize: "0.9rem" }}>
            {info?.role === "admin" ? t("orgSettings.roleAdmin") : t("orgSettings.roleMember")}
          </div>
        </div>

        {error && (
          <p className="form-error" style={{ marginBottom: "1rem" }}>
            {error}
          </p>
        )}

        <button className="primary login-btn" onClick={handleAccept} disabled={accepting}>
          {accepting ? <Spinner /> : t("invite.accept")}
        </button>
      </div>
    </div>
  );
}
