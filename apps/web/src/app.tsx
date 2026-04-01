import { useEffect } from "react";
import { Routes, Route, Outlet, useLocation, Navigate, Link } from "react-router-dom";
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
import { OrgProfileDetailPage } from "./pages/org-profile-detail";
import { ScheduleDetailPage } from "./pages/schedule-detail";
import { ScheduleCreatePage } from "./pages/schedule-create";
import { ScheduleEditPage } from "./pages/schedule-edit";
import { PreferencesPage } from "./pages/preferences";
import { LoginPage } from "./pages/login";
import { RegisterPage } from "./pages/register";
import { VerifyEmailPage } from "./pages/verify-email";
import { ForgotPasswordPage } from "./pages/forgot-password";
import { ResetPasswordPage } from "./pages/reset-password";
import { MagicLinkPage } from "./pages/magic-link";
import { ErrorBoundary } from "./components/error-boundary";
import { AppSidebar } from "./components/app-sidebar";
import { NotificationBell } from "./components/notification-bell";

import { useAuth } from "./hooks/use-auth";
import { useAppConfig } from "./hooks/use-app-config";
import { useOrg } from "./hooks/use-org";
import { useGlobalExecutionSync } from "./hooks/use-global-execution-sync";
import { useApplicationResolver } from "./hooks/use-current-application";
import { useTheme } from "./stores/theme-store";
import { useSidebarStore } from "./stores/sidebar-store";
import { Spinner } from "./components/spinner";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";

function MainLayout() {
  const { resolvedTheme } = useTheme();
  const { open: sidebarOpen, setOpen: setSidebarOpen } = useSidebarStore();
  useApplicationResolver();

  return (
    <SidebarProvider open={sidebarOpen} onOpenChange={setSidebarOpen}>
      <AppSidebar />
      <SidebarInset>
        <header className="flex h-16 shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
          <div className="flex items-center gap-2 px-4">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="mr-2 data-[orientation=vertical]:h-4" />
            <Link to="/">
              <img
                src={resolvedTheme === "dark" ? "/logo-dark.svg" : "/logo-light.svg"}
                alt="Appstrate"
                className="h-7 w-auto"
              />
            </Link>
          </div>
          <div className="flex-1" />
          <div className="px-4">
            <NotificationBell />
          </div>
        </header>
        <div className="flex flex-1 flex-col p-6">
          <Outlet />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}

function GlobalRealtimeSync({ children }: { children: React.ReactNode }) {
  useGlobalExecutionSync();
  return <>{children}</>;
}

/** Routes that don't require an org to be selected. */
const ORG_GATE_BYPASS = ["/welcome", "/onboarding", "/invite"];

function OrgGate({ children }: { children: React.ReactNode }) {
  const { currentOrg, orgs, loading } = useOrg();
  const location = useLocation();

  if (
    ORG_GATE_BYPASS.some((p) => location.pathname === p || location.pathname.startsWith(`${p}/`))
  ) {
    return <>{children}</>;
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner />
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
      <div className="flex min-h-screen items-center justify-center">
        <Spinner />
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
      <div className="flex min-h-screen items-center justify-center">
        <Spinner />
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
            <Route path="/schedules/new" element={<ScheduleCreatePage />} />
            <Route path="/schedules/:id" element={<ScheduleDetailPage />} />
            <Route path="/schedules/:id/edit" element={<ScheduleEditPage />} />
            <Route path="/skills" element={<SkillsPage />} />
            <Route path="/tools" element={<ToolsPage />} />
            <Route path="/providers" element={<ProvidersPage />} />
            <Route
              path="/org-profiles"
              element={<Navigate to="/org-settings#profiles" replace />}
            />
            <Route path="/org-profiles/:id" element={<OrgProfileDetailPage />} />
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
            <Route path="/webhooks" element={<WebhooksPage />} />
            <Route path="/webhooks/:id" element={<WebhookDetailPage />} />
            {/* App-scoped routes (read applicationId from store, like orgId) */}
            <Route path="/end-users" element={<EndUsersPage />} />
            <Route path="/api-keys" element={<ApiKeysPage />} />
            <Route path="/app-settings" element={<AppSettingsPage />} />
            <Route path="/org-settings" element={<OrgSettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </OrgGate>
    </ErrorBoundary>
  );
}
