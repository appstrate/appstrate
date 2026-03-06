import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { refreshAuth } from "../hooks/use-auth";
import { orgStore } from "../stores/org-store";
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
        orgStore.getState().setId(data.orgId);
        await refreshAuth();
        navigate(`/welcome?org=${data.orgId}`);
      } else if (data.requiresLogin) {
        // Existing user but not logged in
        navigate("/");
      } else {
        // Existing user, already logged in — switch org and go home
        if (data.orgId) {
          orgStore.getState().setId(data.orgId);
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
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <div className="w-full max-w-sm rounded-lg border border-border bg-card p-6 shadow-lg">
          <div className="flex items-center justify-center py-8">
            <Spinner />
          </div>
        </div>
      </div>
    );
  }

  if (error && !info) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <div className="w-full max-w-sm rounded-lg border border-border bg-card p-6 shadow-lg">
          <h1 className="text-2xl font-bold text-center mb-2">
            <span>App</span>strate
          </h1>
          <p className="text-sm text-destructive text-center">{error}</p>
          <Button className="w-full mt-4" onClick={() => navigate("/")}>
            {t("invite.goHome")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm rounded-lg border border-border bg-card p-6 shadow-lg">
        <h1 className="text-2xl font-bold text-center mb-2">
          <span>App</span>strate
        </h1>
        <p className="text-center text-sm text-muted-foreground mb-6">
          {t("invite.description", {
            inviter: info?.inviterName,
            org: info?.orgName,
          })}
        </p>

        <div className="rounded-lg border border-border bg-muted/50 p-4 mb-4">
          <div className="text-xs text-muted-foreground">{t("invite.emailLabel")}</div>
          <div className="text-sm font-medium">{info?.email}</div>
          <div className="text-xs text-muted-foreground mt-2">{t("invite.roleLabel")}</div>
          <div className="text-sm font-medium">
            {info?.role === "admin" ? t("orgSettings.roleAdmin") : t("orgSettings.roleMember")}
          </div>
        </div>

        {error && <p className="text-sm text-destructive mt-2">{error}</p>}

        <Button className="w-full mt-4" onClick={handleAccept} disabled={accepting}>
          {accepting ? <Spinner /> : t("invite.accept")}
        </Button>
      </div>
    </div>
  );
}
