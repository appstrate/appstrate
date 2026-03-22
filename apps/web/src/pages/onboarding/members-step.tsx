import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  OnboardingLayout,
  useOnboardingGuard,
  useOnboardingNav,
} from "../../components/onboarding-layout";
import { CopyLinkButton } from "../../components/copy-link-button";
import { api } from "../../api";
import { Spinner } from "../../components/spinner";
import type { OrgInvitation } from "@appstrate/shared-types";

export function OnboardingMembersStep() {
  const { t } = useTranslation(["settings", "common"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const orgId = useOnboardingGuard();
  const { nextRoute, prevRoute } = useOnboardingNav("members");

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [error, setError] = useState<string | null>(null);

  const { data: orgData } = useQuery({
    queryKey: ["org-members", orgId],
    queryFn: () => api<{ invitations: OrgInvitation[] }>(`/orgs/${orgId}`),
    enabled: !!orgId,
  });

  const invitations = orgData?.invitations ?? [];

  const addMemberMutation = useMutation({
    mutationFn: async ({ email, role }: { email: string; role: "member" | "admin" }) => {
      return api<{ invited?: boolean; added?: boolean; token?: string }>(`/orgs/${orgId}/members`, {
        method: "POST",
        body: JSON.stringify({ email, role }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["org-members", orgId] });
      setEmail("");
      setRole("member");
      setError(null);
    },
    onError: (err: Error) => {
      setError(err.message);
    },
  });

  const goNext = () => nextRoute && navigate(nextRoute);

  const handleInvite = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const trimmed = email.trim();
    if (!trimmed) return;
    addMemberMutation.mutate({ email: trimmed, role });
  };

  if (!orgId) return null;

  return (
    <OnboardingLayout
      step="members"
      title={t("onboarding.membersTitle")}
      subtitle={t("onboarding.membersSubtitle")}
      onNext={goNext}
      onBack={prevRoute ? () => navigate(prevRoute) : undefined}
    >
      <div className="flex flex-col gap-4">
        {/* Invite form — fixed above scroll */}
        <form onSubmit={handleInvite} className="flex gap-2 items-start">
          <div className="flex-1">
            <div className="flex gap-2">
              <Input
                type="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setError(null);
                }}
                placeholder="email@example.com"
                required
              />
              <Select value={role} onValueChange={(v) => setRole(v as "member" | "admin")}>
                <SelectTrigger className="w-[140px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="member">{t("orgSettings.roleMember")}</SelectItem>
                  <SelectItem value="admin">{t("orgSettings.roleAdmin")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {error && <p className="text-sm text-destructive mt-1">{error}</p>}
          </div>
          <Button type="submit" disabled={addMemberMutation.isPending}>
            {addMemberMutation.isPending ? <Spinner /> : t("onboarding.invite")}
          </Button>
        </form>

        {/* Pending invitations — scrollable */}
        {invitations.length > 0 && (
          <div className="flex flex-col gap-2 max-h-[30vh] overflow-y-auto">
            <div className="text-sm font-medium text-muted-foreground">
              {t("onboarding.pendingInvitations")}
            </div>
            {invitations.map((inv) => (
              <div key={inv.id} className="rounded-lg border border-border bg-card p-3">
                <div className="flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-medium block truncate">{inv.email}</span>
                  </div>
                  <CopyLinkButton token={inv.token} />
                  <Badge variant="pending">
                    {inv.role === "admin"
                      ? t("orgSettings.roleAdmin")
                      : t("orgSettings.roleMember")}
                  </Badge>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </OnboardingLayout>
  );
}
