import { useEffect } from "react";
import { Routes, Route, Outlet, useLocation, Navigate, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { PackageList } from "./pages/package-list";
import { UnifiedPackageDetailPage } from "./pages/unified-package-detail";
import { PackageEditorPage } from "./pages/package-editor";
import { ExecutionDetailPage } from "./pages/execution-detail";
import { SchedulesListPage } from "./pages/schedules-list";
import { ExecutionsPage } from "./pages/executions-page";
import { DashboardPage } from "./pages/dashboard";
import { InviteAcceptPage } from "./pages/invite-accept";
import { WelcomePage } from "./pages/welcome";
import { OnboardingCreateStep } from "./pages/onboarding/create-step";
import { OnboardingPlanStep } from "./pages/onboarding/plan-step";
import { OnboardingModelStep } from "./pages/onboarding/model-step";
import { OnboardingProvidersStep } from "./pages/onboarding/providers-step";
import { OnboardingMembersStep } from "./pages/onboarding/members-step";
import { OnboardingDoneStep } from "./pages/onboarding/done-step";
import { OrgSettingsPage } from "./pages/org-settings";
import { WebhooksPage } from "./pages/webhooks-page";
import { WebhookDetailPage } from "./pages/webhook-detail-page";
import { ApplicationsPage } from "./pages/applications-page";
import { ApiKeysPage } from "./pages/api-keys-page";
import { EndUsersPage } from "./pages/end-users-page";
import { AppSettingsPage } from "./pages/app-settings-page";
import { SkillsPage } from "./pages/skills-page";
import { ToolsPage } from "./pages/tools-page";
import { ProvidersPage } from "./pages/providers-page";
import { PreferencesPage } from "./pages/preferences";
import { LoginPage } from "./pages/login";
import { RegisterPage } from "./pages/register";
import { VerifyEmailPage } from "./pages/verify-email";
import { ForgotPasswordPage } from "./pages/forgot-password";
import { ResetPasswordPage } from "./pages/reset-password";
import { MagicLinkPage } from "./pages/magic-link";
import { ErrorBoundary } from "./components/error-boundary";
import { OrgSwitcher, NavMenu } from "./components/org-switcher";
import { NotificationBell } from "./components/notification-bell";

import { useQueryClient } from "@tanstack/react-query";
import { useTheme } from "./stores/theme-store";
import { useAuth } from "./hooks/use-auth";
import { useAppConfig } from "./hooks/use-app-config";
import { useOrg } from "./hooks/use-org";
import { useGlobalExecutionSync } from "./hooks/use-global-execution-sync";
import { useProfileAutoSelect } from "./hooks/use-current-profile";
import { useApplicationResolver } from "./hooks/use-current-application";
import { Spinner } from "./components/spinner";
import { User, Settings, FileText, LogOut, Palette } from "lucide-react";
import { themeOptions } from "./lib/theme";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/toaster";

function UserMenu({
  displayName,
  isAdmin,
  onLogout,
}: {
  displayName: string;
  isAdmin?: boolean;
  onLogout: () => void;
}) {
  const { t } = useTranslation();
  const { theme, setTheme } = useTheme();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground hover:text-foreground"
          aria-label={t("userMenu.ariaLabel")}
        >
          <User size={18} className="shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel className="flex items-center gap-2">
          <span>{displayName}</span>
          {isAdmin && (
            <span className="text-[0.65rem] px-1.5 py-0.5 rounded bg-primary/15 text-primary font-medium uppercase">
              {t("admin")}
            </span>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/preferences" className="flex items-center gap-2">
            <Settings size={14} />
            {t("userMenu.preferences")}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Palette size={14} />
            {t("userMenu.theme")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {themeOptions.map(({ value, labelKey, icon: Icon }) => (
              <DropdownMenuItem
                key={value}
                onSelect={() => setTheme(value)}
                className="flex items-center gap-2"
              >
                <Icon size={14} />
                {t(labelKey)}
                {theme === value && <span className="ml-auto text-primary">✓</span>}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem asChild>
          <a
            href="/api/docs"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2"
          >
            <FileText size={14} />
            {t("userMenu.apiDocs")}
          </a>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onLogout} className="flex items-center gap-2">
          <LogOut size={14} />
          {t("userMenu.logout")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MainLayout() {
  const queryClient = useQueryClient();
  const { resolvedTheme } = useTheme();
  const { user, profile, logout } = useAuth();
  const { isOrgAdmin } = useOrg();
  useApplicationResolver();

  const handleLogout = async () => {
    await logout();
    queryClient.clear();
  };

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <header className="flex items-center gap-2 mb-8 pb-4 border-b border-border">
        <Link to="/" className="flex items-center shrink-0 mr-2">
          <img
            src={resolvedTheme === "dark" ? "/logo-dark.svg" : "/logo-light.svg"}
            alt="Appstrate"
            className="h-[34px] w-auto"
          />
        </Link>
        <div className="mx-2 h-5 w-px bg-border" />
        <OrgSwitcher />
        <div className="mr-auto" />
        <NavMenu />
        <NotificationBell />
        <div className="mx-2 h-5 w-px bg-border" />
        <UserMenu
          displayName={profile?.displayName || user!.email || ""}
          isAdmin={isOrgAdmin}
          onLogout={() => void handleLogout()}
        />
      </header>
      <Outlet />
    </div>
  );
}

function GlobalRealtimeSync({ children }: { children: React.ReactNode }) {
  useGlobalExecutionSync();
  useProfileAutoSelect();
  return <>{children}</>;
}

function OrgGate({ children }: { children: React.ReactNode }) {
  const { currentOrg, orgs, loading } = useOrg();
  const location = useLocation();

  // Allow welcome and onboarding routes through without org context
  if (location.pathname === "/welcome" || location.pathname.startsWith("/onboarding")) {
    return <>{children}</>;
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-8">
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <Spinner />
        </div>
      </div>
    );
  }

  // No orgs at all — redirect to onboarding
  if (orgs.length === 0) {
    return <Navigate to="/onboarding/create" replace />;
  }

  // Orgs exist but none selected yet (auto-select happening)
  if (!currentOrg) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-8">
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <Spinner />
        </div>
      </div>
    );
  }

  return <>{children}</>;
}

function useExternalRedirect(isAuthenticated: boolean) {
  const { trustedOrigins } = useAppConfig();

  useEffect(() => {
    if (!isAuthenticated) return;

    const params = new URLSearchParams(window.location.search);
    const redirect = params.get("redirect");
    if (!redirect) return;

    try {
      const origin = new URL(redirect).origin;
      if (trustedOrigins.includes(origin)) {
        window.location.assign(redirect);
      }
    } catch {
      // Invalid URL — ignore
    }
  }, [isAuthenticated, trustedOrigins]);
}

export function App() {
  const { user, loading } = useAuth();
  const { features } = useAppConfig();
  useExternalRedirect(!!user);

  if (loading) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-8">
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <Spinner />
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <ErrorBoundary>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/verify-email" element={<VerifyEmailPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="/magic-link" element={<MagicLinkPage />} />
          <Route path="/invite/:token" element={<InviteAcceptPage />} />
          <Route path="/invite/:token/accept" element={<InviteAcceptPage />} />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      </ErrorBoundary>
    );
  }

  // Authenticated but email not verified — block access until verified
  if (features.smtp && !user.emailVerified) {
    return (
      <ErrorBoundary>
        <Toaster />
        <VerifyEmailPage />
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <Toaster />
      <OrgGate>
        <Routes>
          <Route path="/login" element={<Navigate to="/" replace />} />
          <Route path="/register" element={<Navigate to="/" replace />} />
          <Route path="/invite/:token" element={<InviteAcceptPage />} />
          <Route path="/invite/:token/accept" element={<InviteAcceptPage />} />
          <Route path="/welcome" element={<WelcomePage />} />
          <Route path="/onboarding/create" element={<OnboardingCreateStep />} />
          <Route path="/onboarding/plan" element={<OnboardingPlanStep />} />
          <Route path="/onboarding/model" element={<OnboardingModelStep />} />
          <Route path="/onboarding/providers" element={<OnboardingProvidersStep />} />
          <Route path="/onboarding/members" element={<OnboardingMembersStep />} />
          <Route path="/onboarding/complete" element={<OnboardingDoneStep />} />
          <Route
            element={
              <GlobalRealtimeSync>
                <MainLayout />
              </GlobalRealtimeSync>
            }
          >
            <Route path="/" element={<DashboardPage />} />
            <Route path="/flows" element={<PackageList />} />
            <Route path="/flows/new" element={<PackageEditorPage type="flow" />} />
            <Route path="/flows/:scope/:name/edit" element={<PackageEditorPage type="flow" />} />
            <Route path="/flows/:scope/:name" element={<UnifiedPackageDetailPage type="flow" />} />
            <Route
              path="/flows/:scope/:name/:version"
              element={<UnifiedPackageDetailPage type="flow" />}
            />
            <Route
              path="/flows/:scope/:name/executions/:execId"
              element={<ExecutionDetailPage />}
            />
            <Route path="/executions" element={<ExecutionsPage />} />
            <Route path="/schedules" element={<SchedulesListPage />} />
            <Route path="/skills" element={<SkillsPage />} />
            <Route path="/tools" element={<ToolsPage />} />
            <Route path="/providers" element={<ProvidersPage />} />
            <Route path="/skills/new" element={<PackageEditorPage type="skill" />} />
            <Route path="/skills/:scope/:name/edit" element={<PackageEditorPage type="skill" />} />
            <Route
              path="/skills/:scope/:name"
              element={<UnifiedPackageDetailPage type="skill" />}
            />
            <Route
              path="/skills/:scope/:name/:version"
              element={<UnifiedPackageDetailPage type="skill" />}
            />
            <Route path="/tools/new" element={<PackageEditorPage type="tool" />} />
            <Route path="/tools/:scope/:name/edit" element={<PackageEditorPage type="tool" />} />
            <Route path="/tools/:scope/:name" element={<UnifiedPackageDetailPage type="tool" />} />
            <Route
              path="/tools/:scope/:name/:version"
              element={<UnifiedPackageDetailPage type="tool" />}
            />
            <Route path="/providers/new" element={<PackageEditorPage type="provider" />} />
            <Route
              path="/providers/:scope/:name/edit"
              element={<PackageEditorPage type="provider" />}
            />
            <Route
              path="/providers/:scope/:name"
              element={<UnifiedPackageDetailPage type="provider" />}
            />
            <Route
              path="/providers/:scope/:name/:version"
              element={<UnifiedPackageDetailPage type="provider" />}
            />
            <Route path="/applications" element={<ApplicationsPage />} />
            <Route path="/preferences" element={<PreferencesPage />} />
            {/* App-scoped routes (read applicationId from store, like orgId) */}
            <Route path="/end-users" element={<EndUsersPage />} />
            <Route path="/api-keys" element={<ApiKeysPage />} />
            <Route path="/webhooks" element={<WebhooksPage />} />
            <Route path="/webhooks/:id" element={<WebhookDetailPage />} />
            <Route path="/app-settings" element={<AppSettingsPage />} />
            <Route path="/org-settings" element={<OrgSettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </OrgGate>
    </ErrorBoundary>
  );
}
