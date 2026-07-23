// SPDX-License-Identifier: Apache-2.0

import { useEffect, lazy, Suspense } from "react";
import { Routes, Route, Outlet, useLocation, useSearchParams, Navigate } from "react-router-dom";
import { PackageList } from "./pages/package-list";
import { DashboardPage } from "./pages/dashboard";
import { InviteAcceptPage } from "./pages/invite-accept";
import { LoginPage } from "./pages/login";
import { RegisterPage } from "./pages/register";
import { ClaimPage } from "./pages/claim";
import { VerifyEmailPage } from "./pages/verify-email";
import { ForgotPasswordPage } from "./pages/forgot-password";
import { ResetPasswordPage } from "./pages/reset-password";
import { MagicLinkPage } from "./pages/magic-link";
import { ErrorBoundary } from "./components/error-boundary";
import { HostedAuthGate } from "./components/hosted-auth-gate";
import { AppSidebar } from "./components/app-sidebar";
import { NotificationBell } from "./components/notification-bell";
import { NavUser } from "./components/nav-user";
import { LoadingState } from "./components/page-states";
import { PendingPairingsWatcher } from "./components/pending-pairings-watcher";

import { useAuth } from "./hooks/use-auth";
import { useAppConfig } from "./hooks/use-app-config";
import { useOrg } from "./hooks/use-org";
import { useGlobalRunSync } from "./hooks/use-global-run-sync";
import { useApplicationResolver } from "./hooks/use-current-application";
import { useSidebarStore } from "./stores/sidebar-store";
import { Spinner } from "./components/spinner";
import { HostedConnectPage } from "./pages/hosted-connect";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@appstrate/ui/components/sidebar";
import { AppToaster } from "./components/app-toaster";

// Module-owned pages live under `apps/web/src/modules/<name>/` and are
// lazy-loaded so their bundle is never fetched when the corresponding module
// is disabled (zero-footprint invariant).
const WebhooksPage = lazy(() =>
  import("./modules/webhooks/pages/webhooks-page").then((m) => ({ default: m.WebhooksPage })),
);
const WebhookDetailPage = lazy(() =>
  import("./modules/webhooks/pages/webhook-detail-page").then((m) => ({
    default: m.WebhookDetailPage,
  })),
);
const AuthCallbackPage = lazy(() =>
  import("./modules/oidc/pages/auth-callback").then((m) => ({ default: m.AuthCallbackPage })),
);
const ChatModulePage = lazy(() =>
  import("./modules/chat/chat-page").then((m) => ({ default: m.ChatModulePage })),
);

// Route-level code splitting — heavy authenticated pages are lazy-loaded so
// the entry chunk only carries the login/dashboard shell. Same Suspense +
// LoadingState fallback pattern as the module pages above.
const UnifiedPackageDetailPage = lazy(() =>
  import("./pages/unified-package-detail").then((m) => ({ default: m.UnifiedPackageDetailPage })),
);
const PackageEditorPage = lazy(() =>
  import("./pages/package-editor").then((m) => ({ default: m.PackageEditorPage })),
);
const RunDetailPage = lazy(() =>
  import("./pages/run-detail").then((m) => ({ default: m.RunDetailPage })),
);
const RunsPage = lazy(() => import("./pages/runs-page").then((m) => ({ default: m.RunsPage })));
const DocumentsPage = lazy(() =>
  import("./pages/documents").then((m) => ({ default: m.DocumentsPage })),
);
const SchedulesListPage = lazy(() =>
  import("./pages/schedules-list").then((m) => ({ default: m.SchedulesListPage })),
);
const ScheduleDetailPage = lazy(() =>
  import("./pages/schedule-detail").then((m) => ({ default: m.ScheduleDetailPage })),
);
const ScheduleCreatePage = lazy(() =>
  import("./pages/schedule-create").then((m) => ({ default: m.ScheduleCreatePage })),
);
const ScheduleEditPage = lazy(() =>
  import("./pages/schedule-edit").then((m) => ({ default: m.ScheduleEditPage })),
);
const SkillsPage = lazy(() =>
  import("./pages/skills-page").then((m) => ({ default: m.SkillsPage })),
);
const McpServersPage = lazy(() =>
  import("./pages/mcp-servers-page").then((m) => ({ default: m.McpServersPage })),
);
const IntegrationsPage = lazy(() =>
  import("./pages/integrations-page").then((m) => ({ default: m.IntegrationsPage })),
);
const IntegrationDetailPage = lazy(() =>
  import("./pages/integration-detail").then((m) => ({ default: m.IntegrationDetailPage })),
);
const LibraryPage = lazy(() =>
  import("./pages/library-page").then((m) => ({ default: m.LibraryPage })),
);
const EndUsersPage = lazy(() =>
  import("./pages/end-users-page").then((m) => ({ default: m.EndUsersPage })),
);
const ApiKeysPage = lazy(() =>
  import("./pages/api-keys-page").then((m) => ({ default: m.ApiKeysPage })),
);
const WelcomePage = lazy(() => import("./pages/welcome").then((m) => ({ default: m.WelcomePage })));
const OnboardingCreateStep = lazy(() =>
  import("./pages/onboarding/create-step").then((m) => ({ default: m.OnboardingCreateStep })),
);
const OnboardingPlanStep = lazy(() =>
  import("./pages/onboarding/plan-step").then((m) => ({ default: m.OnboardingPlanStep })),
);
const OnboardingModelStep = lazy(() =>
  import("./pages/onboarding/model-step").then((m) => ({ default: m.OnboardingModelStep })),
);
const OnboardingMembersStep = lazy(() =>
  import("./pages/onboarding/members-step").then((m) => ({ default: m.OnboardingMembersStep })),
);
const OnboardingDoneStep = lazy(() =>
  import("./pages/onboarding/done-step").then((m) => ({ default: m.OnboardingDoneStep })),
);
const OnboardingWaitingStep = lazy(() =>
  import("./pages/onboarding/waiting-step").then((m) => ({ default: m.OnboardingWaitingStep })),
);
const OrgSettingsLayout = lazy(() =>
  import("./pages/org-settings/layout").then((m) => ({ default: m.OrgSettingsLayout })),
);
const OrgSettingsGeneralPage = lazy(() =>
  import("./pages/org-settings/general").then((m) => ({ default: m.OrgSettingsGeneralPage })),
);
const OrgSettingsMembersPage = lazy(() =>
  import("./pages/org-settings/members").then((m) => ({ default: m.OrgSettingsMembersPage })),
);
const OrgSettingsModelsPage = lazy(() =>
  import("./pages/org-settings/models").then((m) => ({ default: m.OrgSettingsModelsPage })),
);
const OrgSettingsProxiesPage = lazy(() =>
  import("./pages/org-settings/proxies").then((m) => ({ default: m.OrgSettingsProxiesPage })),
);
const OrgSettingsOAuthPage = lazy(() =>
  import("./pages/org-settings/oauth").then((m) => ({ default: m.OrgSettingsOAuthPage })),
);
const OrgSettingsBillingPage = lazy(() =>
  import("./pages/org-settings/billing").then((m) => ({ default: m.OrgSettingsBillingPage })),
);
const OrgSettingsCliSessionsPage = lazy(() =>
  import("./pages/org-settings/cli-sessions").then((m) => ({
    default: m.OrgSettingsCliSessionsPage,
  })),
);
const OrgSettingsApplicationsPage = lazy(() =>
  import("./pages/org-settings/applications").then((m) => ({
    default: m.OrgSettingsApplicationsPage,
  })),
);
const OrgSettingsAppGeneralPage = lazy(() =>
  import("./pages/org-settings/app/general").then((m) => ({
    default: m.OrgSettingsAppGeneralPage,
  })),
);
const OrgSettingsAppAuthPage = lazy(() =>
  import("./pages/org-settings/app/auth").then((m) => ({ default: m.OrgSettingsAppAuthPage })),
);
const OrgSettingsAppOauthPage = lazy(() =>
  import("./pages/org-settings/app/oauth").then((m) => ({ default: m.OrgSettingsAppOauthPage })),
);
const PreferencesLayout = lazy(() =>
  import("./pages/preferences/layout").then((m) => ({ default: m.PreferencesLayout })),
);
const PreferencesGeneralPage = lazy(() =>
  import("./pages/preferences/general").then((m) => ({ default: m.PreferencesGeneralPage })),
);
const PreferencesAppearancePage = lazy(() =>
  import("./pages/preferences/appearance").then((m) => ({ default: m.PreferencesAppearancePage })),
);
const PreferencesSecurityPage = lazy(() =>
  import("./pages/preferences/security").then((m) => ({ default: m.PreferencesSecurityPage })),
);
const PreferencesConnectionsPage = lazy(() =>
  import("./pages/preferences/connections").then((m) => ({
    default: m.PreferencesConnectionsPage,
  })),
);
const PreferencesDevicesPage = lazy(() =>
  import("./pages/preferences/devices").then((m) => ({ default: m.PreferencesDevicesPage })),
);

/** Suspense boundary for lazy route elements — same fallback as module pages. */
function LazyRoute({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<LoadingState />}>{children}</Suspense>;
}

function MainLayout() {
  const { open: sidebarOpen, setOpen: setSidebarOpen } = useSidebarStore();
  useApplicationResolver();

  return (
    <SidebarProvider open={sidebarOpen} onOpenChange={setSidebarOpen}>
      <AppSidebar />
      <SidebarInset className="h-svh">
        <header className="flex h-16 shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
          {/* Mobile-only trigger — desktop collapse lives in the sidebar header */}
          <SidebarTrigger className="ml-2 md:hidden" />
          <div className="flex-1" />
          <div className="flex items-center gap-1 px-4">
            <NotificationBell />
            <NavUser />
          </div>
        </header>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <Outlet />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}

function GlobalRealtimeSync({ children }: { children: React.ReactNode }) {
  useGlobalRunSync();
  return <>{children}</>;
}

/** Routes that don't require an org to be selected. */
const ORG_GATE_BYPASS = ["/welcome", "/onboarding", "/invite", "/auth/callback"];

/**
 * Bridge for server-side redirects that land at `/auth/login?returnTo=...`.
 *
 * Only same-origin absolute paths are accepted — no schemes, no host,
 * no path-traversal tricks — so this cannot be abused as an open
 * redirect even if the `returnTo` query lands in an attacker-controlled
 * email. Anything malformed silently falls through to the default
 * post-login destination (`/`).
 */
/**
 * Accept only same-origin relative paths. Rejects protocol-relative and
 * absolute-scheme values — including the backslash bypass (`/\evil.com`,
 * `/\/evil.com`), which browsers normalize to `//evil.com`. Backslashes are
 * folded to forward slashes before the protocol-relative test, mirroring the
 * OIDC redirect sanitizer, so a crafted `returnTo` in an attacker-controlled
 * email cannot become an open redirect.
 */
function sanitizeReturnTo(raw: string | null): string | undefined {
  if (!raw || !raw.startsWith("/")) return undefined;
  const normalized = raw.replace(/\\/g, "/");
  // Protocol-relative (`//host`) after backslash normalization → reject.
  if (normalized.startsWith("//")) return undefined;
  return raw;
}

function AuthLoginReturnToBridge() {
  const [params] = useSearchParams();
  const from = sanitizeReturnTo(params.get("returnTo"));
  return <Navigate to="/login" replace state={from ? { from } : undefined} />;
}

function OrgGate({ children }: { children: React.ReactNode }) {
  const { currentOrg, orgs, loading } = useOrg();
  const { features } = useAppConfig();
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

  // No orgs at all -- redirect to onboarding (or to "waiting for invitation"
  // when org creation is locked down — issue #228 closed mode).
  if (orgs.length === 0) {
    return (
      <Navigate
        to={features.orgCreationDisabled ? "/onboarding/waiting" : "/onboarding/create"}
        replace
      />
    );
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
      const url = new URL(redirect);
      if (
        (url.protocol === "https:" || url.protocol === "http:") &&
        trustedOrigins.includes(url.origin)
      ) {
        window.location.assign(url.href);
      }
    } catch {
      // Invalid URL -- ignore
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

  // Hosted connect portal (issue #769) — standalone, auth-agnostic. Rendered
  // before every auth/bootstrap gate because it authenticates via its own
  // httpOnly page cookie (pinned by the dispatch redirect), not the platform
  // session: it must work for embedded end-users with no Better Auth user.
  if (window.location.pathname === "/connect") {
    return (
      <ErrorBoundary>
        <HostedConnectPage />
      </ErrorBoundary>
    );
  }

  // Bootstrap-token redemption (#344 Layer 2b) — when the platform has a
  // pending unattended-install token AND the visitor isn't authenticated,
  // every route funnels into `/claim`. The redeem route owns its own gate
  // (timing-safe compare + DB-org-count); the SPA's job is just to render
  // the form and prevent users from wandering into login/register on a
  // closed-by-default fresh instance.
  if (!user && features.bootstrapTokenPending) {
    return (
      <ErrorBoundary>
        <Routes>
          <Route path="/claim" element={<ClaimPage />} />
          <Route path="*" element={<Navigate to="/claim" replace />} />
        </Routes>
      </ErrorBoundary>
    );
  }

  if (!user) {
    return (
      <ErrorBoundary>
        <Routes>
          {/*
           * The auth-entry routes are wrapped in `HostedAuthGate`: in OIDC
           * mode it redirects to the hosted login/register page before the
           * native form mounts (one mechanism, no per-page `useEffect`
           * check to forget); in OSS mode it renders the form below. The
           * ESLint `auth-client` ban (eslint.config.mjs) backs this up by
           * stopping any of these pages from calling Better Auth directly.
           */}
          <Route
            path="/login"
            element={
              <HostedAuthGate starter="login">
                <LoginPage />
              </HostedAuthGate>
            }
          />
          {/*
           * `/register` stays mounted even when `signupDisabled` is true so
           * the closed-mode bootstrap owner (and any
           * `AUTH_PLATFORM_ADMIN_EMAILS` entry) can sign up via
           * email/password without needing Google/GitHub/SMTP. The real
           * barrier is server-side in `databaseHooks.user.create.before` —
           * unauthorized signups receive a `signup_disabled` error that
           * `RegisterPage` surfaces. The signup link is still hidden from
           * `/login` to avoid public discoverability.
           */}
          <Route
            path="/register"
            element={
              <HostedAuthGate starter="signup">
                <RegisterPage />
              </HostedAuthGate>
            }
          />
          {/*
           * Server-rendered flows outside the SPA (e.g. the device-flow
           * `/activate` page) redirect unauthenticated visitors here with
           * a `?returnTo=<path>` query. Capture it into `state.from`
           * before forwarding to `/login` so `LoginPage`'s existing
           * `location.state?.from` hookup feeds it into
           * `startOidcLogin(redirectTo)` and the callback returns to the
           * original page. The `replace` keeps the back button sane.
           */}
          <Route path="/auth/login" element={<AuthLoginReturnToBridge />} />
          {features.oidc && (
            <Route
              path="/auth/callback"
              element={
                <Suspense
                  fallback={
                    <div className="flex min-h-screen items-center justify-center">
                      <Spinner />
                    </div>
                  }
                >
                  <AuthCallbackPage />
                </Suspense>
              }
            />
          )}
          {/*
           * `/verify-email` is deliberately NOT gated: it is a post-signup
           * interstitial (and verification-error display), not a login entry
           * point. In OIDC + SMTP mode the server-rendered register flow can
           * route an unauthenticated visitor here with `?email=` / `?error=`
           * (see verify-email.tsx) — redirecting it to the hosted login would
           * break that flow. It renders natively in both modes.
           */}
          <Route path="/verify-email" element={<VerifyEmailPage />} />
          <Route
            path="/forgot-password"
            element={
              <HostedAuthGate starter="login">
                <ForgotPasswordPage />
              </HostedAuthGate>
            }
          />
          <Route
            path="/reset-password"
            element={
              <HostedAuthGate starter="login">
                <ResetPasswordPage />
              </HostedAuthGate>
            }
          />
          <Route
            path="/magic-link"
            element={
              <HostedAuthGate starter="login">
                <MagicLinkPage />
              </HostedAuthGate>
            }
          />
          {/*
           * `/invite/:token` is NOT wrapped: it loads invite data first, then
           * drives `useHostedAuthRedirect` directly with a starter (login vs
           * signup) and login-hint derived from that data. Same seam, dynamic
           * inputs — see invite-accept.tsx.
           */}
          <Route path="/invite/:token" element={<InviteAcceptPage />} />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      </ErrorBoundary>
    );
  }

  // Authenticated but email not verified -- block access until verified
  if (features.smtp && !user.emailVerified) {
    return (
      <ErrorBoundary>
        <AppToaster />
        <VerifyEmailPage />
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <AppToaster />
      {/*
       * Mounted outside OrgGate/MainLayout so an in-flight OAuth pairing
       * completes (toast + credential invalidation) even when the user is
       * on an onboarding route or closed the modal that started it.
       */}
      <PendingPairingsWatcher />
      <OrgGate>
        <Routes>
          <Route path="/login" element={<Navigate to="/" replace />} />
          <Route path="/register" element={<Navigate to="/" replace />} />
          {/*
           * `/auth/callback` must be reachable while authenticated too: by
           * the time the browser lands here, the BA session cookie is
           * already set by the server, so `useAuth()` flips us into this
           * block before `AuthCallbackPage` runs. Without the route here
           * the URL falls through to the catch-all and the `sessionStorage`
           * returnTo we stashed pre-login is never consumed.
           */}
          {features.oidc && (
            <Route
              path="/auth/callback"
              element={
                <Suspense
                  fallback={
                    <div className="flex min-h-screen items-center justify-center">
                      <Spinner />
                    </div>
                  }
                >
                  <AuthCallbackPage />
                </Suspense>
              }
            />
          )}
          <Route path="/invite/:token" element={<InviteAcceptPage />} />
          <Route
            path="/welcome"
            element={
              <LazyRoute>
                <WelcomePage />
              </LazyRoute>
            }
          />
          <Route
            path="/onboarding/waiting"
            element={
              <LazyRoute>
                <OnboardingWaitingStep />
              </LazyRoute>
            }
          />
          <Route
            path="/onboarding/create"
            element={
              <LazyRoute>
                <OnboardingCreateStep />
              </LazyRoute>
            }
          />
          <Route
            path="/onboarding/plan"
            element={
              <LazyRoute>
                <OnboardingPlanStep />
              </LazyRoute>
            }
          />
          <Route
            path="/onboarding/model"
            element={
              <LazyRoute>
                <OnboardingModelStep />
              </LazyRoute>
            }
          />
          <Route
            path="/onboarding/members"
            element={
              <LazyRoute>
                <OnboardingMembersStep />
              </LazyRoute>
            }
          />
          <Route
            path="/onboarding/complete"
            element={
              <LazyRoute>
                <OnboardingDoneStep />
              </LazyRoute>
            }
          />
          <Route
            element={
              <GlobalRealtimeSync>
                <MainLayout />
              </GlobalRealtimeSync>
            }
          >
            <Route path="/" element={<DashboardPage />} />
            <Route path="/agents" element={<PackageList />} />
            <Route
              path="/agents/new"
              element={
                <LazyRoute>
                  <PackageEditorPage type="agent" />
                </LazyRoute>
              }
            />
            <Route
              path="/agents/:scope/:name/edit"
              element={
                <LazyRoute>
                  <PackageEditorPage type="agent" />
                </LazyRoute>
              }
            />
            <Route
              path="/agents/:scope/:name"
              element={
                <LazyRoute>
                  <UnifiedPackageDetailPage type="agent" />
                </LazyRoute>
              }
            />
            <Route
              path="/agents/:scope/:name/:version"
              element={
                <LazyRoute>
                  <UnifiedPackageDetailPage type="agent" />
                </LazyRoute>
              }
            />
            <Route
              path="/agents/:scope/:name/runs/:runId"
              element={
                <LazyRoute>
                  <RunDetailPage />
                </LazyRoute>
              }
            />
            <Route
              path="/runs"
              element={
                <LazyRoute>
                  <RunsPage />
                </LazyRoute>
              }
            />
            <Route
              path="/documents"
              element={
                <LazyRoute>
                  <DocumentsPage />
                </LazyRoute>
              }
            />
            <Route
              path="/schedules"
              element={
                <LazyRoute>
                  <SchedulesListPage />
                </LazyRoute>
              }
            />
            <Route
              path="/schedules/new"
              element={
                <LazyRoute>
                  <ScheduleCreatePage />
                </LazyRoute>
              }
            />
            <Route
              path="/schedules/:id"
              element={
                <LazyRoute>
                  <ScheduleDetailPage />
                </LazyRoute>
              }
            />
            <Route
              path="/schedules/:id/edit"
              element={
                <LazyRoute>
                  <ScheduleEditPage />
                </LazyRoute>
              }
            />
            <Route
              path="/skills"
              element={
                <LazyRoute>
                  <SkillsPage />
                </LazyRoute>
              }
            />
            <Route
              path="/integrations"
              element={
                <LazyRoute>
                  <IntegrationsPage />
                </LazyRoute>
              }
            />
            <Route
              path="/integrations/new"
              element={
                <LazyRoute>
                  <PackageEditorPage type="integration" />
                </LazyRoute>
              }
            />
            <Route
              path="/integrations/:scope/:name/edit"
              element={
                <LazyRoute>
                  <PackageEditorPage type="integration" />
                </LazyRoute>
              }
            />
            <Route
              path="/integrations/:scope/:name"
              element={
                <LazyRoute>
                  <IntegrationDetailPage />
                </LazyRoute>
              }
            />
            <Route
              path="/skills/new"
              element={
                <LazyRoute>
                  <PackageEditorPage type="skill" />
                </LazyRoute>
              }
            />
            <Route
              path="/skills/:scope/:name/edit"
              element={
                <LazyRoute>
                  <PackageEditorPage type="skill" />
                </LazyRoute>
              }
            />
            <Route
              path="/skills/:scope/:name"
              element={
                <LazyRoute>
                  <UnifiedPackageDetailPage type="skill" />
                </LazyRoute>
              }
            />
            <Route
              path="/skills/:scope/:name/:version"
              element={
                <LazyRoute>
                  <UnifiedPackageDetailPage type="skill" />
                </LazyRoute>
              }
            />
            <Route
              path="/mcp-servers"
              element={
                <LazyRoute>
                  <McpServersPage />
                </LazyRoute>
              }
            />
            <Route
              path="/mcp-servers/:scope/:name"
              element={
                <LazyRoute>
                  <UnifiedPackageDetailPage type="mcp-server" />
                </LazyRoute>
              }
            />
            <Route
              path="/mcp-servers/:scope/:name/:version"
              element={
                <LazyRoute>
                  <UnifiedPackageDetailPage type="mcp-server" />
                </LazyRoute>
              }
            />
            <Route
              path="/library"
              element={
                <LazyRoute>
                  <LibraryPage />
                </LazyRoute>
              }
            />
            <Route
              path="/applications"
              element={<Navigate to="/org-settings/applications" replace />}
            />
            <Route
              path="/preferences"
              element={
                <LazyRoute>
                  <PreferencesLayout />
                </LazyRoute>
              }
            >
              <Route index element={<Navigate to="general" replace />} />
              <Route path="general" element={<PreferencesGeneralPage />} />
              <Route path="appearance" element={<PreferencesAppearancePage />} />
              <Route path="security" element={<PreferencesSecurityPage />} />
              <Route path="devices" element={<PreferencesDevicesPage />} />
              <Route path="connections" element={<PreferencesConnectionsPage />} />
            </Route>
            {features.webhooks && (
              <>
                <Route
                  path="/webhooks"
                  element={
                    <Suspense fallback={<LoadingState />}>
                      <WebhooksPage />
                    </Suspense>
                  }
                />
                <Route
                  path="/webhooks/:id"
                  element={
                    <Suspense fallback={<LoadingState />}>
                      <WebhookDetailPage />
                    </Suspense>
                  }
                />
              </>
            )}
            {features.chat && (
              <>
                <Route
                  path="/chat"
                  element={
                    <Suspense fallback={<LoadingState />}>
                      <ChatModulePage />
                    </Suspense>
                  }
                />
                <Route
                  path="/chat/:conversationId"
                  element={
                    <Suspense fallback={<LoadingState />}>
                      <ChatModulePage />
                    </Suspense>
                  }
                />
              </>
            )}
            {/* App-scoped routes (read applicationId from store, like orgId) */}
            <Route
              path="/end-users"
              element={
                <LazyRoute>
                  <EndUsersPage />
                </LazyRoute>
              }
            />
            <Route
              path="/app-settings"
              element={<Navigate to="/org-settings/app/general" replace />}
            />
            <Route
              path="/org-settings"
              element={
                <LazyRoute>
                  <OrgSettingsLayout />
                </LazyRoute>
              }
            >
              <Route index element={<Navigate to="general" replace />} />
              <Route path="general" element={<OrgSettingsGeneralPage />} />
              <Route path="members" element={<OrgSettingsMembersPage />} />
              <Route path="applications" element={<OrgSettingsApplicationsPage />} />
              <Route path="models" element={<OrgSettingsModelsPage />} />
              <Route path="proxies" element={<OrgSettingsProxiesPage />} />
              <Route path="oauth" element={<OrgSettingsOAuthPage />} />
              <Route path="cli-sessions" element={<OrgSettingsCliSessionsPage />} />
              <Route path="billing" element={<OrgSettingsBillingPage />} />
              <Route path="app/general" element={<OrgSettingsAppGeneralPage />} />
              <Route path="app/api-keys" element={<ApiKeysPage />} />
              <Route path="app/auth" element={<OrgSettingsAppAuthPage />} />
              <Route path="app/oauth" element={<OrgSettingsAppOauthPage />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </OrgGate>
    </ErrorBoundary>
  );
}
