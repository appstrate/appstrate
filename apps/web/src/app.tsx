// SPDX-License-Identifier: Apache-2.0

import { useEffect, lazy, Suspense, type ReactNode } from "react";
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
import { MagicLinkConfirmPage } from "./pages/magic-link-confirm";
import { ErrorBoundary } from "./components/error-boundary";
import { HostedAuthGate } from "./components/hosted-auth-gate";
import { AppSidebar } from "./components/app-sidebar";
import { OverlayExitProvider, OverlayProvider, useOverlayState } from "./lib/modal-route";
import {
  catalogueChunk,
  orgSettingsGeneralChunk,
  preferencesGeneralChunk,
  settingsLayoutChunk,
  workspaceSettingsGeneralChunk,
} from "./lib/overlay-chunks";
import { chunkComponent } from "./lib/lazy-chunk";
import { OverlayUnavailable } from "./components/overlay-unavailable";
import { ShellFrameProvider, ShellHeader } from "./components/shell-frame";
import { LoadingState } from "./components/page-states";
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
import { Spinner } from "./components/spinner";
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

// Module-owned pages live under `apps/web/src/modules/<name>/` and are
// lazy-loaded so their bundle is never fetched when the corresponding module
// is disabled (zero-footprint invariant): `RouteGate` renders its unavailable
// state, never the page, for a route whose declared `feature` is off.
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
const FilesPage = lazy(() => import("./pages/files").then((m) => ({ default: m.FilesPage })));
const SchedulesListPage = lazy(() =>
  import("./pages/schedules-list").then((m) => ({ default: m.SchedulesListPage })),
);
const ScheduleDetailPage = lazy(() =>
  import("./pages/schedule-detail").then((m) => ({ default: m.ScheduleDetailPage })),
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
const UnifiedSettingsLayout = chunkComponent(settingsLayoutChunk, (m) => m.UnifiedSettingsLayout);
const CataloguePage = chunkComponent(catalogueChunk, (m) => m.CataloguePage);
const CatalogueIndexRedirect = chunkComponent(catalogueChunk, (m) => m.CatalogueIndexRedirect);
const SettingsIndexRedirect = chunkComponent(settingsLayoutChunk, (m) => m.SettingsIndexRedirect);
const OrgSettingsGeneralPage = chunkComponent(
  orgSettingsGeneralChunk,
  (m) => m.OrgSettingsGeneralPage,
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
const PreferencesMcpAccessPage = lazy(() =>
  import("./pages/preferences/mcp-access").then((m) => ({
    default: m.PreferencesMcpAccessPage,
  })),
);
const OrgSettingsBillingPage = lazy(() =>
  import("./pages/org-settings/billing").then((m) => ({ default: m.OrgSettingsBillingPage })),
);
const OrgSettingsCliSessionsPage = lazy(() =>
  import("./pages/org-settings/cli-sessions").then((m) => ({
    default: m.OrgSettingsCliSessionsPage,
  })),
);
const OrgSettingsRolesPage = lazy(() =>
  import("./pages/org-settings/roles").then((m) => ({ default: m.OrgSettingsRolesPage })),
);
const OrgSettingsSpacesPage = lazy(() =>
  import("./pages/org-settings/spaces").then((m) => ({
    default: m.OrgSettingsSpacesPage,
  })),
);
const WorkspaceSettingsGeneralPage = chunkComponent(
  workspaceSettingsGeneralChunk,
  (m) => m.WorkspaceSettingsGeneralPage,
);
const WorkspaceSettingsMembersPage = lazy(() =>
  import("./pages/workspace-settings/members").then((m) => ({
    default: m.WorkspaceSettingsMembersPage,
  })),
);
const WorkspaceSettingsAuthPage = lazy(() =>
  import("./pages/workspace-settings/auth").then((m) => ({ default: m.WorkspaceSettingsAuthPage })),
);
const WorkspaceSettingsOAuthPage = lazy(() =>
  import("./pages/workspace-settings/oauth").then((m) => ({
    default: m.WorkspaceSettingsOAuthPage,
  })),
);
const PreferencesGeneralPage = chunkComponent(
  preferencesGeneralChunk,
  (m) => m.PreferencesGeneralPage,
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
const PreferencesModelsPage = lazy(() =>
  import("./pages/preferences/models").then((m) => ({ default: m.PreferencesModelsPage })),
);

/** Suspense boundary for lazy route elements — same fallback as module pages. */
function LazyRoute({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<LoadingState />}>{children}</Suspense>;
}

/**
 * The page of every signed-in route, keyed like its access declaration
 * (`lib/route-access.ts`): a route without one, or one without a page, fails to
 * compile. Mounted by `pageRoute`, always behind `RouteGate`; `mountOf` decides
 * which tree mounts it.
 */
const PAGES: Record<RoutePath, ReactNode> = {
  "/": <DashboardPage />,
  "/agents": <PackageList />,
  "/agents/new": (
    <LazyRoute>
      <PackageEditorPage type="agent" />
    </LazyRoute>
  ),
  "/agents/:scope/:name": (
    <LazyRoute>
      <UnifiedPackageDetailPage type="agent" />
    </LazyRoute>
  ),
  "/agents/:scope/:name/:version": (
    <LazyRoute>
      <UnifiedPackageDetailPage type="agent" />
    </LazyRoute>
  ),
  "/agents/:scope/:name/runs/:runId": (
    <LazyRoute>
      <RunDetailPage />
    </LazyRoute>
  ),
  "/runs": (
    <LazyRoute>
      <RunsPage />
    </LazyRoute>
  ),
  "/files": (
    <LazyRoute>
      <FilesPage />
    </LazyRoute>
  ),
  "/schedules": (
    <LazyRoute>
      <SchedulesListPage />
    </LazyRoute>
  ),
  "/schedules/:id": (
    <LazyRoute>
      <ScheduleDetailPage />
    </LazyRoute>
  ),
  "/skills": (
    <LazyRoute>
      <SkillsPage />
    </LazyRoute>
  ),
  "/skills/new": (
    <LazyRoute>
      <PackageEditorPage type="skill" />
    </LazyRoute>
  ),
  "/skills/:scope/:name": (
    <LazyRoute>
      <UnifiedPackageDetailPage type="skill" />
    </LazyRoute>
  ),
  "/skills/:scope/:name/:version": (
    <LazyRoute>
      <UnifiedPackageDetailPage type="skill" />
    </LazyRoute>
  ),
  "/integrations": (
    <LazyRoute>
      <IntegrationsPage />
    </LazyRoute>
  ),
  "/integrations/new": (
    <LazyRoute>
      <PackageEditorPage type="integration" />
    </LazyRoute>
  ),
  "/integrations/:scope/:name": (
    <LazyRoute>
      <IntegrationDetailPage />
    </LazyRoute>
  ),
  "/mcp-servers": (
    <LazyRoute>
      <McpServersPage />
    </LazyRoute>
  ),
  "/mcp-servers/:scope/:name": (
    <LazyRoute>
      <UnifiedPackageDetailPage type="mcp-server" />
    </LazyRoute>
  ),
  "/mcp-servers/:scope/:name/:version": (
    <LazyRoute>
      <UnifiedPackageDetailPage type="mcp-server" />
    </LazyRoute>
  ),
  // The catalogue is a destination like settings, not a per-list modal: one
  // address, reachable from the navigation. Bare, it redirects to its first view.
  "/catalogue": (
    <LazyRoute>
      <CatalogueIndexRedirect />
    </LazyRoute>
  ),
  "/catalogue/:reading/:type": (
    <LazyRoute>
      <CataloguePage />
    </LazyRoute>
  ),
  "/preferences": <Outlet />,
  "/preferences/general": <PreferencesGeneralPage />,
  "/preferences/appearance": <PreferencesAppearancePage />,
  "/preferences/security": <PreferencesSecurityPage />,
  "/preferences/devices": <PreferencesDevicesPage />,
  "/preferences/connections": <PreferencesConnectionsPage />,
  "/preferences/mcp-access": <PreferencesMcpAccessPage />,
  "/preferences/models": <PreferencesModelsPage />,
  "/chat": (
    <LazyRoute>
      <ChatModulePage />
    </LazyRoute>
  ),
  "/chat/:conversationId": (
    <LazyRoute>
      <ChatModulePage />
    </LazyRoute>
  ),
  // The settings scopes (these two and `/preferences`) share
  // `UnifiedSettingsLayout`, mounted one level up so switching scope keeps the
  // dialog; each scope's own element is its outlet.
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
  // Workspace settings are their own surface, scoped by `X-Space-Id` — a
  // different scope from the org, not a subsection of it. The one exception is
  // webhooks: that page also manages the organization's own (`org-webhooks:read`).
  "/workspace-settings": <Outlet />,
  "/workspace-settings/general": <WorkspaceSettingsGeneralPage />,
  // Space membership and its custom roles: who is in THIS space, and as what.
  // Org members are the other surface — a person can hold an org role and no
  // seat here.
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

function pageRoute(path: RoutePath) {
  return (
    <Route key={path} path={path} element={<RouteGate path={path}>{PAGES[path]}</RouteGate>} />
  );
}

function layoutRoute(layout: LayoutPath) {
  return (
    <Route
      key={layout}
      path={layout}
      element={<RouteGate path={layout}>{PAGES[layout]}</RouteGate>}
    >
      <Route index element={<SettingsIndexRedirect />} />
      {PATHS.filter((path) => path.startsWith(`${layout}/`)).map(pageRoute)}
    </Route>
  );
}

/**
 * The one boot placeholder. Every gate below renders it, so a visitor sees a
 * single uninterrupted spinner while the boot reads settle, never a sequence
 * of visually identical ones handed off between gates.
 *
 * The boot reads themselves are started in `main.tsx`, in parallel: by the
 * time `useAuth()` reports a user the org list is usually already cached, so
 * `OrgGate` normally resolves without ever painting this.
 */
function BootScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <Spinner />
    </div>
  );
}

/**
 * The ONE layout of both products. Studio and the chat are different products
 * with different navigations, but they share a frame — sidebar, header,
 * realtime stream, resolved space — and switching product must not tear that
 * frame down: only the sidebar's navigation, the inset's sizing and the page
 * change. A layout per product would remount all of it on every switch (the
 * realtime stream reconnecting, the sidebar's queries re-reading, a lazy chat
 * chunk blanking the whole screen while it loads).
 *
 * The space is resolved HERE, above the route gate: `RouteGate` waits on a
 * resolved space before it refuses, and every request a page makes is scoped by
 * it. The realtime sync covers the chat too: a chat turn runs agents, and their
 * progress is pushed on the same stream.
 */
function MainLayout() {
  const studioSidebar = useSidebarStore();
  const chatSidebar = useChatSidebarStore();
  const { pathname } = useLocation();
  const product = isUnder(pathname, "/chat") ? "chat" : "studio";
  // Each product remembers its own fold (`stores/sidebar-store.ts`).
  const sidebar = product === "chat" ? chatSidebar : studioSidebar;
  useSpaceResolver();
  useGlobalRunSync();

  return (
    <ShellFrameProvider>
      <SidebarProvider open={sidebar.open} onOpenChange={sidebar.setOpen}>
        <AppSidebar product={product} />
        {/* `bg-canvas` overrides SidebarInset's own `bg-background`: the content
            column is page canvas (grey), not a component surface (white). */}
        {/* Studio: the scroll lives HERE, not on an inner div: a scroll container
            inside the inset would narrow the content by the scrollbar width
            while the header above it kept the full width, and the profile would
            sit 15px further right than the content it is supposed to line up
            with. Chat: no page scroll — it owns its height, the thread scrolls
            inside itself and the composer stays pinned. */}
        <SidebarInset
          className={
            product === "chat"
              ? "bg-canvas h-svh min-h-0 overflow-hidden"
              : "bg-canvas h-svh overflow-y-auto"
          }
        >
          <ShellHeader />
          {/* Must stay visible on every route, including the settings layouts and
              the permission-denied pages a persona is precisely there to provoke. */}
          <ViewAsBanner />
          {/* Opened by `?newSchedule=` from any page: the schedules list, an agent. */}
          <NewScheduleModalHost />
          {/* Full-bleed surfaces (anything that owns its own height) opt out
              with `data-full-bleed` on their root. */}
          <div
            className={
              product === "chat"
                ? "flex min-h-0 min-w-0 flex-1"
                : "max-w-page px-gutter mx-auto w-full pt-8 pb-18 has-[[data-full-bleed]]:max-w-none has-[[data-full-bleed]]:p-0"
            }
          >
            {/* A page that crashes on render takes only itself down: the sidebar
                and the header stay, and navigating away clears the error. */}
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
  // While an overlay is up the page tree renders the page it opened over, so
  // that page stays exactly as the user left it — scroll, filters and all —
  // instead of unmounting.
  const { page, overlay, exit } = useOverlayState();
  useExternalRedirect(!!user);

  if (loading) {
    return <BootScreen />;
  }

  // Hosted connect portal — standalone, auth-agnostic. Rendered
  // before every auth/bootstrap gate because it authenticates via its own
  // httpOnly page cookie (pinned by the dispatch redirect), not the platform
  // session: it must work for embedded end-users with no Better Auth user.
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

  // Bootstrap-token redemption — when the platform has a
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
           * an invited address can sign up via email/password without
           * Google/GitHub/SMTP. The real
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
                <Suspense fallback={<BootScreen />}>
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
      {/*
       * Mounted outside OrgGate/MainLayout so an in-flight OAuth pairing
       * completes (toast + credential invalidation) even when the user is
       * on an onboarding route or closed the modal that started it.
       */}
      <PendingPairingsWatcher />
      <OrgGate>
        <OverlayProvider value={overlay}>
          <OverlayExitProvider value={exit}>
            <Routes location={page}>
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
                    <Suspense fallback={<BootScreen />}>
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
              <Route element={<MainLayout />}>
                {flatPaths("main").map(pageRoute)}
                <Route path="*" element={<NotFoundPage />} />
              </Route>
            </Routes>
            {/* Overlay tree — the ONLY home of the routed modals. The tree above
                renders the page under the overlay, so a second copy there could
                never match; that is why there is no page-shaped variant to keep
                in sync. Outside MainLayout's boundary, so it has its own: the
                root one is cleared by no navigation. */}
            {overlay && (
              <ErrorBoundary resetKey={location.pathname}>
                <Routes>
                  {flatPaths("overlay").map(pageRoute)}
                  <Route
                    element={
                      <LazyRoute>
                        <UnifiedSettingsLayout />
                      </LazyRoute>
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
