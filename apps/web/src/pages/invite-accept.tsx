import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { refreshAuth } from "../hooks/use-auth";
import { orgStore } from "../stores/org-store";
import { Spinner } from "../components/spinner";
import { AuthLayout } from "../components/auth-layout";

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
        orgStore.getState().setId(data.orgId);
        await refreshAuth();
        navigate(`/welcome?org=${data.orgId}`);
      } else if (data.requiresLogin) {
        navigate("/");
      } else {
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
      <AuthLayout>
        <div className="flex items-center justify-center py-8">
          <Spinner />
        </div>
      </AuthLayout>
    );
  }

  if (error && !info) {
    return (
      <AuthLayout>
        <div className="flex flex-col gap-6">
          <div className="flex flex-col items-center gap-2">
            <h1 className="text-xl font-bold">
              <span>App</span>strate
            </h1>
          </div>
          <p className="text-sm text-destructive text-center">{error}</p>
          <Button className="w-full" onClick={() => navigate("/")}>
            {t("invite.goHome")}
          </Button>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col items-center gap-2">
          <h1 className="text-xl font-bold">
            <span>App</span>strate
          </h1>
          <p className="text-center text-sm text-muted-foreground">
            {t("invite.description", {
              inviter: info?.inviterName,
              org: info?.orgName,
            })}
          </p>
        </div>

        <div className="rounded-lg border bg-muted/50 p-4">
          <div className="text-xs text-muted-foreground">{t("invite.emailLabel")}</div>
          <div className="text-sm font-medium">{info?.email}</div>
          <div className="text-xs text-muted-foreground mt-2">{t("invite.roleLabel")}</div>
          <div className="text-sm font-medium">
            {info?.role === "admin" ? t("orgSettings.roleAdmin") : t("orgSettings.roleMember")}
          </div>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <Button className="w-full" onClick={handleAccept} disabled={accepting}>
          {accepting ? <Spinner /> : t("invite.accept")}
        </Button>
      </div>
    </AuthLayout>
  );
}
