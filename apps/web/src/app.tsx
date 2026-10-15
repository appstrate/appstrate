// SPDX-License-Identifier: Apache-2.0

import { useEffect, Suspense, type ReactNode } from "react";
import { Routes, Route, Outlet, useLocation, useSearchParams, Navigate } from "react-router-dom";
import { PackageIndexPage } from "./pages/package-index";
import { DashboardPage } from "./pages/dashboard";
import { InviteAcceptPage } from "./pages/invite-accept";
import { LoginPage } from "./pages/login";
import { RegisterPage } from "./pages/register";
import { ClaimPage } from "./pages/claim";
import { VerifyEmailPage } from "./pages/verify-email";
import { ForgotPasswordPage } from "./pages/forgot-password";
import { ResetPasswordPage } from "./pages/reset-password";
import { MagicLinkPage } from "./pages/magic-link";
import { MagicLinkConfirmPage } from "./pages/magic-link-confirm";
import { ErrorBoundary } from "./components/error-boundary";
import { HostedAuthGate } from "./components/hosted-auth-gate";
import { OverlayExitProvider, OverlayProvider, useOverlayState } from "./lib/modal-route";
import {
  catalogueChunk,
  orgSettingsGeneralChunk,
  preferencesGeneralChunk,
  settingsLayoutChunk,
  workspaceSettingsGeneralChunk,
} from "./lib/overlay-chunks";
import { chunkComponent, lazyPage } from "./lib/lazy-chunk";
import { OverlayUnavailable } from "./components/overlay-unavailable";
import { AppSidebar, ShellFrameProvider, ShellHeader } from "./components/app-shell";
import {
  ChatPanelSkeleton,
  DashboardSkeleton,
  FormPageSkeleton,
  ListPageSkeleton,
  OverlayPanelSkeleton,
  PackageDetailSkeleton,
  RunDetailSkeleton,
  ScheduleDetailSkeleton,
  SettingsSkeleton,
} from "./components/loading-skeletons";
import { PendingPairingsWatcher } from "./components/pending-pairings-watcher";
import { ViewAsBanner } from "./components/view-as-banner";
import { NewScheduleModalHost } from "./components/new-schedule-modal";

import { useAuth, useCanCreateOrg } from "./hooks/use-auth";
import { signedOutDestination } from "./lib/auth-flow";
import { orgLessEntry } from "./lib/onboarding-entry";
import { useAppConfig } from "./hooks/use-app-config";
import { useOrg } from "./hooks/use-org";
import { useGlobalRunSync } from "./hooks/use-global-run-sync";
import { useSpaceResolver } from "./hooks/use-current-space";
import { NotFoundPage, RouteGate } from "./components/route-gate";
import { useChatSidebarStore, useSidebarStore } from "./stores/sidebar-store";
import { Spinner } from "@appstrate/ui/components/spinner";
import { HostedConnectPage } from "./pages/hosted-connect";
import { SidebarInset, SidebarProvider } from "@appstrate/ui/components/sidebar";
import { AppToaster } from "./components/app-toaster";
import {
  isOverlayPath,
  isUnder,
  OVERLAY_NOT_FOUND_PATHS,
  SETTINGS_INDEX,
  type RoutePath,
} from "./lib/route-access";
import type { PackageType } from "@appstrate/core/validation";

// Module pages are lazy-loaded so a disabled module's bundle is never fetched
// (zero-footprint): `RouteGate` renders its unavailable state when the `feature` is off.
const WebhooksPage = lazyPage(
  () => import("./modules/webhooks/pages/webhooks-page"),
  "WebhooksPage",
);
const WebhookDetailPage = lazyPage(
  () => import("./modules/webhooks/pages/webhook-detail-page"),
  "WebhookDetailPage",
);
const AuthCallbackPage = lazyPage(
  () => import("./modules/oidc/pages/auth-callback"),
  "AuthCallbackPage",
);
const ChatModulePage = lazyPage(() => import("./modules/chat/chat-page"), "ChatModulePage");

// Heavy authenticated pages are lazy-loaded; each waits on its chunk under `skeletonOf`.
const UnifiedPackageDetailPage = lazyPage(
  () => import("./pages/unified-package-detail"),
  "UnifiedPackageDetailPage",
);
const PackageEditorPage = lazyPage(() => import("./pages/package-editor"), "PackageEditorPage");
const RunDetailPage = lazyPage(() => import("./pages/run-detail"), "RunDetailPage");
const RunsPage = lazyPage(() => import("./pages/runs-page"), "RunsPage");
const FilesPage = lazyPage(() => import("./pages/files"), "FilesPage");
const SchedulesListPage = lazyPage(() => import("./pages/schedules-list"), "SchedulesListPage");
const ScheduleDetailPage = lazyPage(() => import("./pages/schedule-detail"), "ScheduleDetailPage");
const SkillsPage = lazyPage(() => import("./pages/skills-page"), "SkillsPage");
const McpServersPage = lazyPage(() => import("./pages/mcp-servers-page"), "McpServersPage");
const IntegrationsPage = lazyPage(() => import("./pages/integrations-page"), "IntegrationsPage");
const IntegrationDetailPage = lazyPage(
  () => import("./pages/integration-detail"),
  "IntegrationDetailPage",
);

const EndUsersPage = lazyPage(() => import("./pages/end-users-page"), "EndUsersPage");
const ApiKeysPage = lazyPage(() => import("./pages/api-keys-page"), "ApiKeysPage");
const WelcomePage = lazyPage(() => import("./pages/welcome"), "WelcomePage");
const OnboardingCreateStep = lazyPage(
  () => import("./pages/onboarding/create-step"),
  "OnboardingCreateStep",
);
const OnboardingPlanStep = lazyPage(
  () => import("./pages/onboarding/plan-step"),
  "OnboardingPlanStep",
);
const OnboardingModelStep = lazyPage(
  () => import("./pages/onboarding/model-step"),
  "OnboardingModelStep",
);
const OnboardingMembersStep = lazyPage(
  () => import("./pages/onboarding/members-step"),
  "OnboardingMembersStep",
);
const OnboardingDoneStep = lazyPage(
  () => import("./pages/onboarding/done-step"),
  "OnboardingDoneStep",
);
const OnboardingWaitingStep = lazyPage(
  () => import("./pages/onboarding/waiting-step"),
  "OnboardingWaitingStep",
);
const UnifiedSettingsLayout = chunkComponent(settingsLayoutChunk, (m) => m.UnifiedSettingsLayout);
const CataloguePage = chunkComponent(catalogueChunk, (m) => m.CataloguePage);
const CatalogueIndexRedirect = chunkComponent(catalogueChunk, (m) => m.CatalogueIndexRedirect);
const SettingsIndexRedirect = chunkComponent(settingsLayoutChunk, (m) => m.SettingsIndexRedirect);
const OrgSettingsGeneralPage = chunkComponent(
  orgSettingsGeneralChunk,
  (m) => m.OrgSettingsGeneralPage,
);
const OrgSettingsMembersPage = lazyPage(
  () => import("./pages/org-settings/members"),
  "OrgSettingsMembersPage",
);
const OrgSettingsModelsPage = lazyPage(
  () => import("./pages/org-settings/models"),
  "OrgSettingsModelsPage",
);
const OrgSettingsProxiesPage = lazyPage(
  () => import("./pages/org-settings/proxies"),
  "OrgSettingsProxiesPage",
);
const OrgSettingsOAuthPage = lazyPage(
  () => import("./pages/org-settings/oauth"),
  "OrgSettingsOAuthPage",
);
const PreferencesMcpAccessPage = lazyPage(
  () => import("./pages/preferences/mcp-access"),
  "PreferencesMcpAccessPage",
);
const OrgSettingsBillingPage = lazyPage(
  () => import("./pages/org-settings/billing"),
  "OrgSettingsBillingPage",
);
const OrgSettingsCliSessionsPage = lazyPage(
  () => import("./pages/org-settings/cli-sessions"),
  "OrgSettingsCliSessionsPage",
);
const OrgSettingsRolesPage = lazyPage(
  () => import("./pages/org-settings/roles"),
  "OrgSettingsRolesPage",
);
const OrgSettingsSpacesPage = lazyPage(
  () => import("./pages/org-settings/spaces"),
  "OrgSettingsSpacesPage",
);
const WorkspaceSettingsGeneralPage = chunkComponent(
  workspaceSettingsGeneralChunk,
  (m) => m.WorkspaceSettingsGeneralPage,
);
const WorkspaceSettingsMembersPage = lazyPage(
  () => import("./pages/workspace-settings/members"),
  "WorkspaceSettingsMembersPage",
);
const WorkspaceSettingsAuthPage = lazyPage(
  () => import("./pages/workspace-settings/auth"),
  "WorkspaceSettingsAuthPage",
);
const WorkspaceSettingsOAuthPage = lazyPage(
  () => import("./pages/workspace-settings/oauth"),
  "WorkspaceSettingsOAuthPage",
);
const PreferencesGeneralPage = chunkComponent(
  preferencesGeneralChunk,
  (m) => m.PreferencesGeneralPage,
);
const PreferencesAppearancePage = lazyPage(
  () => import("./pages/preferences/appearance"),
  "PreferencesAppearancePage",
);
const PreferencesSecurityPage = lazyPage(
  () => import("./pages/preferences/security"),
  "PreferencesSecurityPage",
);
const PreferencesConnectionsPage = lazyPage(
  () => import("./pages/preferences/connections"),
  "PreferencesConnectionsPage",
);
const PreferencesDevicesPage = lazyPage(
  () => import("./pages/preferences/devices"),
  "PreferencesDevicesPage",
);
const PreferencesModelsPage = lazyPage(
  () => import("./pages/preferences/models"),
  "PreferencesModelsPage",
);

/** A lazy screen outside the shell (welcome, onboarding): it waits like the boot does. */
function PreShellRoute({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<BootScreen />}>{children}</Suspense>;
}

/** The screens outside the shell, in the order of the onboarding. */
const PRE_SHELL_PAGES = [
  ["/welcome", WelcomePage],
  ["/onboarding/waiting", OnboardingWaitingStep],
  ["/onboarding/create", OnboardingCreateStep],
  ["/onboarding/plan", OnboardingPlanStep],
  ["/onboarding/model", OnboardingModelStep],
  ["/onboarding/members", OnboardingMembersStep],
  ["/onboarding/complete", OnboardingDoneStep],
] as const;

/**
 * The page of every signed-in route, keyed like its access declaration
 * (`lib/route-access.ts`): a route without one, or one without a page, fails to compile.
 */
const PAGES: Record<RoutePath, ReactNode> = {
  "/": <DashboardPage />,
  "/agents": <PackageIndexPage type="agent" />,
  "/agents/new": <PackageEditorPage type="agent" />,
  "/agents/:scope/:name": <UnifiedPackageDetailPage type="agent" />,
  "/agents/:scope/:name/:version": <UnifiedPackageDetailPage type="agent" />,
  "/agents/:scope/:name/runs/:runId": <RunDetailPage />,
  "/runs": <RunsPage />,
  "/files": <FilesPage />,
  "/schedules": <SchedulesListPage />,
  "/schedules/:id": <ScheduleDetailPage />,
  "/skills": <SkillsPage />,
  "/skills/new": <PackageEditorPage type="skill" />,
  "/skills/:scope/:name": <UnifiedPackageDetailPage type="skill" />,
  "/skills/:scope/:name/:version": <UnifiedPackageDetailPage type="skill" />,
  "/integrations": <IntegrationsPage />,
  "/integrations/new": <PackageEditorPage type="integration" />,
  "/integrations/:scope/:name": <IntegrationDetailPage />,
  "/mcp-servers": <McpServersPage />,
  "/mcp-servers/:scope/:name": <UnifiedPackageDetailPage type="mcp-server" />,
  "/mcp-servers/:scope/:name/:version": <UnifiedPackageDetailPage type="mcp-server" />,
  "/catalogue": <CatalogueIndexRedirect />,
  "/catalogue/:reading/:type": <CataloguePage />,
  "/preferences": <Outlet />,
  "/preferences/general": <PreferencesGeneralPage />,
  "/preferences/appearance": <PreferencesAppearancePage />,
  "/preferences/security": <PreferencesSecurityPage />,
  "/preferences/devices": <PreferencesDevicesPage />,
  "/preferences/connections": <PreferencesConnectionsPage />,
  "/preferences/mcp-access": <PreferencesMcpAccessPage />,
  "/preferences/models": <PreferencesModelsPage />,
  "/chat": <ChatModulePage />,
  "/chat/:conversationId": <ChatModulePage />,
  // The settings scopes share `UnifiedSettingsLayout` (mounted one level up, so switching scope keeps the dialog).
  "/org-settings": <Outlet />,
  "/org-settings/general": <OrgSettingsGeneralPage />,
  "/org-settings/members": <OrgSettingsMembersPage />,
  "/org-settings/roles": <OrgSettingsRolesPage />,
  "/org-settings/spaces": <OrgSettingsSpacesPage />,
  "/org-settings/models": <OrgSettingsModelsPage />,
  "/org-settings/proxies": <OrgSettingsProxiesPage />,
  "/org-settings/oauth": <OrgSettingsOAuthPage />,
  "/org-settings/cli-sessions": <OrgSettingsCliSessionsPage />,
  "/org-settings/billing": <OrgSettingsBillingPage />,
  // Workspace settings are scoped by `X-Space-Id`, except webhooks, which also manages the org's own (`org-webhooks:read`).
  "/workspace-settings": <Outlet />,
  "/workspace-settings/general": <WorkspaceSettingsGeneralPage />,
  "/workspace-settings/members": <WorkspaceSettingsMembersPage />,
  "/workspace-settings/auth": <WorkspaceSettingsAuthPage />,
  "/workspace-settings/api-keys": <ApiKeysPage />,
  "/workspace-settings/oauth": <WorkspaceSettingsOAuthPage />,
  "/workspace-settings/end-users": <EndUsersPage />,
  "/workspace-settings/webhooks": <WebhooksPage />,
  "/workspace-settings/webhooks/:id": <WebhookDetailPage />,
};

const PATHS = Object.keys(PAGES) as RoutePath[];

/**
 * Routed modals mount in the overlay tree ONLY (the main tree renders the
 * background location, so a copy there could never match).
 */
function mountOf(path: RoutePath): "main" | "overlay" {
  return isOverlayPath(path) ? "overlay" : "main";
}

/** The nested layouts: the settings scopes, each index opening the scope's first page. */
const LAYOUTS = Object.values(SETTINGS_INDEX);
type LayoutPath = (typeof LAYOUTS)[number];
const inLayout = (path: RoutePath) => LAYOUTS.some((layout) => isUnder(path, layout));

/** A mount's routes that no layout nests. */
const flatPaths = (mount: ReturnType<typeof mountOf>) =>
  PATHS.filter((path) => mountOf(path) === mount && !inLayout(path));

/** The package detail routes, by family. */
const DETAIL_PACKAGE_TYPE: [string, PackageType][] = [
  ["/agents/", "agent"],
  ["/skills/", "skill"],
  ["/mcp-servers/", "mcp-server"],
  ["/integrations/", "integration"],
];

/** What a route draws while its chunk or permissions load: the same skeleton its page draws for data. */
function skeletonOf(path: RoutePath): ReactNode {
  if (inLayout(path)) return <SettingsSkeleton />;
  if (isOverlayPath(path)) return <OverlayPanelSkeleton list />;
  if (isUnder(path, "/chat")) return <ChatPanelSkeleton />;
  if (path === "/") return <DashboardSkeleton />;
  if (path.endsWith("/new")) return <FormPageSkeleton />;
  if (path === "/agents/:scope/:name/runs/:runId") return <RunDetailSkeleton />;
  if (path === "/schedules/:id") return <ScheduleDetailSkeleton />;
  const packageType = DETAIL_PACKAGE_TYPE.find(([prefix]) => path.startsWith(prefix))?.[1];
  if (packageType && path.includes("/:")) return <PackageDetailSkeleton type={packageType} />;
  return <ListPageSkeleton />;
}

function pageRoute(path: RoutePath) {
  const skeleton = skeletonOf(path);
  return (
    <Route
      key={path}
      path={path}
      element={
        <RouteGate path={path} pending={skeleton}>
          <Suspense fallback={skeleton}>{PAGES[path]}</Suspense>
        </RouteGate>
      }
    />
  );
}

function layoutRoute(layout: LayoutPath) {
  return (
    <Route
      key={layout}
      path={layout}
      element={
        <RouteGate path={layout} pending={<SettingsSkeleton />}>
          {PAGES[layout]}
        </RouteGate>
      }
    >
      <Route index element={<SettingsIndexRedirect />} />
      {PATHS.filter((path) => path.startsWith(`${layout}/`)).map(pageRoute)}
    </Route>
  );
}

/** The one boot placeholder every gate renders, so a visitor sees a single uninterrupted spinner. */
function BootScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <Spinner />
    </div>
  );
}

/**
 * The ONE layout of both products (Studio and the chat): switching product must not
 * remount the shared frame (realtime stream, sidebar queries). The space is resolved
 * HERE, above the route gate, which waits on it before it refuses. The realtime sync
 * covers the chat too: a chat turn runs agents.
 */
function MainLayout() {
  const studioSidebar = useSidebarStore();
  const chatSidebar = useChatSidebarStore();
  const { pathname } = useLocation();
  const product = isUnder(pathname, "/chat") ? "chat" : "studio";
  const sidebar = product === "chat" ? chatSidebar : studioSidebar;
  useSpaceResolver();
  useGlobalRunSync();

  return (
    <ShellFrameProvider>
      <SidebarProvider open={sidebar.open} onOpenChange={sidebar.setOpen}>
        <AppSidebar product={product} />
        {/* Studio: the scroll lives HERE, not on an inner div (which would narrow the content
            by the scrollbar width and misalign it with the header). Chat owns its height. */}
        <SidebarInset
          className={
            product === "chat"
              ? "bg-canvas h-svh min-h-0 overflow-hidden"
              : "bg-canvas h-svh overflow-y-auto"
          }
        >
          <ShellHeader />
          {/* Must stay visible on every route, permission-denied pages included. */}
          <ViewAsBanner />
          {/* Opened by `?newSchedule=` from any page. */}
          <NewScheduleModalHost />
          {/* Full-bleed surfaces opt out with `data-full-bleed` on their root. */}
          <div
            className={
              product === "chat"
                ? "flex min-h-0 min-w-0 flex-1 *:flex-1"
                : "max-w-page px-gutter mx-auto w-full pt-8 pb-18 has-[[data-full-bleed]]:max-w-none has-[[data-full-bleed]]:p-0"
            }
          >
            <ErrorBoundary resetKey={pathname}>
              <Outlet />
            </ErrorBoundary>
          </div>
        </SidebarInset>
      </SidebarProvider>
    </ShellFrameProvider>
  );
}

/** Routes that don't require an org to be selected. */
const ORG_GATE_BYPASS = ["/welcome", "/onboarding", "/invite", "/auth/callback"];

/**
 * SECURITY: accept only same-origin relative paths (open-redirect guard for a `returnTo`
 * that may come from an attacker-controlled email). Rejects protocol-relative and
 * absolute-scheme values, including the backslash bypass (`/\evil.com`) that browsers
 * normalize to `//evil.com`; mirrors the OIDC redirect sanitizer. Malformed falls through to `/`.
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
  const canCreateOrg = useCanCreateOrg();
  const location = useLocation();

  if (
    ORG_GATE_BYPASS.some((p) => location.pathname === p || location.pathname.startsWith(`${p}/`))
  ) {
    return <>{children}</>;
  }

  if (loading) {
    return <BootScreen />;
  }

  // No orgs at all -- redirect to onboarding (or to "waiting for invitation"
  // when this user may not create one, the closed mode).
  if (orgs.length === 0) {
    return <Navigate to={orgLessEntry(canCreateOrg)} replace />;
  }

  // Orgs exist but none selected yet (auto-select happening)
  if (!currentOrg) {
    return <BootScreen />;
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

function SignedOutFallback() {
  const { search } = useLocation();
  return <Navigate to={signedOutDestination(search)} replace />;
}

export function App() {
  const { user, loading } = useAuth();
  const { features } = useAppConfig();
  const location = useLocation();
  // While an overlay is up the page tree renders the page it opened over (scroll and filters kept).
  const { page, overlay, exit } = useOverlayState();
  useExternalRedirect(!!user);

  if (loading) {
    return <BootScreen />;
  }

  // Hosted connect portal: rendered before every gate because it authenticates via its own
  // httpOnly page cookie, so it must work for embedded end-users with no Better Auth user.
  if (location.pathname === "/connect") {
    return (
      <ErrorBoundary>
        <HostedConnectPage />
      </ErrorBoundary>
    );
  }

  // Honoured whoever is signed in: the link's account replaces the session.
  if (location.pathname === "/magic-link/confirm") {
    return (
      <ErrorBoundary>
        <MagicLinkConfirmPage />
      </ErrorBoundary>
    );
  }

  // A pending unattended-install token funnels every unauthenticated route into `/claim`;
  // the redeem route owns its own gate server-side.
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
          {/* Auth-entry routes go through `HostedAuthGate`: in OIDC mode it redirects to the
              hosted page before the native form mounts. */}
          <Route
            path="/login"
            element={
              <HostedAuthGate starter="login">
                <LoginPage />
              </HostedAuthGate>
            }
          />
          {/* `/register` stays mounted when `signupDisabled` so an invited address can sign up;
              the real barrier is server-side (`databaseHooks.user.create.before`). */}
          <Route
            path="/register"
            element={
              <HostedAuthGate starter="signup">
                <RegisterPage />
              </HostedAuthGate>
            }
          />
          {/* Server-rendered flows (device-flow `/activate`) land here with `?returnTo=`;
              the bridge moves it into `state.from` for `LoginPage`. */}
          <Route path="/auth/login" element={<AuthLoginReturnToBridge />} />
          {features.oidc && (
            <Route
              path="/auth/callback"
              element={
                <Suspense fallback={<BootScreen />}>
                  <AuthCallbackPage />
                </Suspense>
              }
            />
          )}
          {/* `/verify-email` is deliberately NOT gated: in OIDC + SMTP mode the server-rendered
              register flow routes unauthenticated visitors here (see verify-email.tsx). */}
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
          {/* `/invite/:token` is NOT wrapped: it drives `useHostedAuthRedirect` itself (invite-accept.tsx). */}
          <Route path="/invite/:token" element={<InviteAcceptPage />} />
          <Route path="*" element={<SignedOutFallback />} />
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
      {/* Outside OrgGate/MainLayout so an in-flight OAuth pairing completes on any route. */}
      <PendingPairingsWatcher />
      <OrgGate>
        <OverlayProvider value={overlay}>
          <OverlayExitProvider value={exit}>
            <Routes location={page}>
              <Route path="/login" element={<Navigate to="/" replace />} />
              <Route path="/register" element={<Navigate to="/" replace />} />
              {/* `/auth/callback` must also exist here: the session cookie is already set when the
                  browser lands, so without it the stashed `returnTo` is never consumed. */}
              {features.oidc && (
                <Route
                  path="/auth/callback"
                  element={
                    <Suspense fallback={<BootScreen />}>
                      <AuthCallbackPage />
                    </Suspense>
                  }
                />
              )}
              <Route path="/invite/:token" element={<InviteAcceptPage />} />
              {PRE_SHELL_PAGES.map(([path, Page]) => (
                <Route
                  key={path}
                  path={path}
                  element={
                    <PreShellRoute>
                      <Page />
                    </PreShellRoute>
                  }
                />
              ))}
              <Route element={<MainLayout />}>
                {flatPaths("main").map(pageRoute)}
                <Route path="*" element={<NotFoundPage />} />
              </Route>
            </Routes>
            {/* Overlay tree: the ONLY home of the routed modals. Outside MainLayout's boundary, so it has its own. */}
            {overlay && (
              <ErrorBoundary resetKey={location.pathname}>
                <Routes>
                  {flatPaths("overlay").map(pageRoute)}
                  <Route
                    element={
                      <Suspense fallback={<OverlayPanelSkeleton />}>
                        <UnifiedSettingsLayout />
                      </Suspense>
                    }
                  >
                    {LAYOUTS.map(layoutRoute)}
                  </Route>
                  {OVERLAY_NOT_FOUND_PATHS.map((path) => (
                    <Route key={path} path={path} element={<OverlayUnavailable />} />
                  ))}
                </Routes>
              </ErrorBoundary>
            )}
          </OverlayExitProvider>
        </OverlayProvider>
      </OrgGate>
    </ErrorBoundary>
  );
}
