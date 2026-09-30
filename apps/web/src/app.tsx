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
import { ErrorBoundary } from "./components/error-boundary";
import { HostedAuthGate } from "./components/hosted-auth-gate";
import { AppSidebar } from "./components/app-sidebar";
import { useBackgroundLocation } from "./lib/modal-route";
import { RedirectAppSettings } from "./components/redirect-app-settings";
import { ShellHeader } from "./components/shell-frame";
import { LoadingState } from "./components/page-states";
import { PendingPairingsWatcher } from "./components/pending-pairings-watcher";
import { ViewAsBanner } from "./components/view-as-banner";

import { useAuth } from "./hooks/use-auth";
import { useAppConfig } from "./hooks/use-app-config";
import { useOrg } from "./hooks/use-org";
import { useGlobalRunSync } from "./hooks/use-global-run-sync";
import { useSpaceResolver } from "./hooks/use-current-space";
import { RouteGate } from "./components/route-gate";
import { NavigateKeepingState } from "./components/navigate-keeping-state";
import { useSidebarStore } from "./stores/sidebar-store";
import { Spinner } from "./components/spinner";
import { HostedConnectPage } from "./pages/hosted-connect";
import { SidebarInset, SidebarProvider } from "@appstrate/ui/components/sidebar";
import { AppToaster } from "./components/app-toaster";
import type { RoutePath } from "./lib/route-access";

// Module-owned pages live under `apps/web/src/modules/<name>/` and are
// lazy-loaded so their bundle is never fetched when the corresponding module
// is disabled (zero-footprint invariant): `RouteGate` redirects before
// rendering a route whose declared `feature` is off.
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
const UnifiedSettingsLayout = lazy(() =>
  import("./pages/settings/layout").then((m) => ({
    default: m.UnifiedSettingsLayout,
  })),
);
const CataloguePage = lazy(() =>
  import("./pages/catalogue").then((m) => ({ default: m.CataloguePage })),
);
const SettingsIndexRedirect = lazy(() =>
  import("./pages/settings/layout").then((m) => ({
    default: m.SettingsIndexRedirect,
  })),
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
const OrgSettingsAppGeneralPage = lazy(() =>
  import("./pages/org-settings/app/general").then((m) => ({
    default: m.OrgSettingsAppGeneralPage,
  })),
);
const OrgSettingsSpaceMembersPage = lazy(() =>
  import("./pages/org-settings/space/members").then((m) => ({
    default: m.OrgSettingsSpaceMembersPage,
  })),
);
const OrgSettingsAppAuthPage = lazy(() =>
  import("./pages/org-settings/app/auth").then((m) => ({ default: m.OrgSettingsAppAuthPage })),
);
const OrgSettingsSpaceOauthPage = lazy(() =>
  import("./pages/org-settings/space/oauth").then((m) => ({
    default: m.OrgSettingsSpaceOauthPage,
  })),
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
  "/agents/:scope/:name/edit": (
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
  "/schedules/new": (
    <LazyRoute>
      <ScheduleCreatePage />
    </LazyRoute>
  ),
  "/schedules/:id": (
    <LazyRoute>
      <ScheduleDetailPage />
    </LazyRoute>
  ),
  "/schedules/:id/edit": (
    <LazyRoute>
      <ScheduleEditPage />
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
  "/skills/:scope/:name/edit": (
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
  "/integrations/:scope/:name/edit": (
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
  "/mcp-servers/:scope/:name/edit": (
    <LazyRoute>
      <PackageEditorPage type="mcp-server" />
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
  // address, reachable from the navigation.
  "/catalogue": (
    <LazyRoute>
      <CataloguePage />
    </LazyRoute>
  ),
  "/catalogue/:origin/:type": (
    <LazyRoute>
      <CataloguePage />
    </LazyRoute>
  ),
  "/preferences": (
    <LazyRoute>
      <PreferencesLayout />
    </LazyRoute>
  ),
  "/preferences/general": <PreferencesGeneralPage />,
  "/preferences/appearance": <PreferencesAppearancePage />,
  "/preferences/security": <PreferencesSecurityPage />,
  "/preferences/devices": <PreferencesDevicesPage />,
  "/preferences/connections": <PreferencesConnectionsPage />,
  "/preferences/mcp-access": <PreferencesMcpAccessPage />,
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
  // Both settings scopes share `UnifiedSettingsLayout`, mounted one level up so
  // switching scope keeps the dialog; each scope's own element is its outlet.
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
  // Workspace settings are their own surface: everything below is scoped by
  // `X-Application-Id`, which is a different scope from the org, not a
  // subsection of it.
  "/workspace-settings": <Outlet />,
  "/workspace-settings/general": <OrgSettingsAppGeneralPage />,
  // Space membership and its custom roles: who is in THIS space, and as what.
  // Org members are the other surface — a person can hold an org role and no
  // seat here.
  "/workspace-settings/members": <OrgSettingsSpaceMembersPage />,
  "/workspace-settings/auth": <OrgSettingsAppAuthPage />,
  "/workspace-settings/api-keys": <ApiKeysPage />,
  "/workspace-settings/oauth": <OrgSettingsSpaceOauthPage />,
  "/workspace-settings/end-users": <EndUsersPage />,
  "/workspace-settings/webhooks": <WebhooksPage />,
  "/workspace-settings/webhooks/:id": <WebhookDetailPage />,
};

const PATHS = Object.keys(PAGES) as RoutePath[];

/**
 * Routed modals: opened over the screen they came from, so they mount in the
 * overlay tree ONLY (the main tree renders the background location, so a copy
 * there could never match). The chat brings its own shell.
 */
const OVERLAY_PREFIXES = ["/org-settings", "/workspace-settings", "/preferences", "/catalogue"];
const CHAT_PREFIX = "/chat";

const isUnder = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

function mountOf(path: RoutePath): "main" | "chat" | "overlay" {
  if (isUnder(path, CHAT_PREFIX)) return "chat";
  return OVERLAY_PREFIXES.some((prefix) => isUnder(path, prefix)) ? "overlay" : "main";
}

/** The nested layouts, with what each index opens. */
const LAYOUT_INDEX = {
  "/preferences": <Navigate to="general" replace />,
  "/org-settings": <SettingsIndexRedirect />,
  "/workspace-settings": <SettingsIndexRedirect />,
} satisfies Partial<Record<RoutePath, ReactNode>>;
type LayoutPath = keyof typeof LAYOUT_INDEX;
const LAYOUTS = Object.keys(LAYOUT_INDEX) as LayoutPath[];
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
      <Route index element={LAYOUT_INDEX[layout]} />
      {PATHS.filter((path) => path.startsWith(`${layout}/`)).map(pageRoute)}
    </Route>
  );
}

/**
 * Old addresses, kept because they are in bookmarks and docs. Each lands on a
 * declared route, whose gate then decides; none renders a page of its own.
 */
const PAGE_REDIRECTS: Record<string, ReactNode> = {
  // One space's inventory and the org library were the placement model again,
  // narrowed. The catalogue's placed half is that view, graded by the caller.
  "/space/packages": <Navigate to="/catalogue/placed/agent" replace />,
  "/library": <NavigateKeepingState to="/catalogue/placed/agent" />,
  "/applications": <Navigate to="/org-settings/spaces" replace />,
  "/app-settings": <Navigate to="/workspace-settings/general" replace />,
  "/end-users": <Navigate to="/workspace-settings/end-users" replace />,
  "/webhooks": <Navigate to="/workspace-settings/webhooks" replace />,
};

/** Same, for addresses under an overlay prefix: only the overlay tree sees them. */
const OVERLAY_REDIRECTS: Record<string, ReactNode> = {
  // Workspace settings used to live inside the organisation's, as
  // `/org-settings/app/*` here and `/org-settings/space/*` on main.
  "/org-settings/app/:tab": <RedirectAppSettings />,
  "/org-settings/space/:tab": <RedirectAppSettings />,
  "/org-settings/library": <Navigate to="/catalogue/placed/agent" replace />,
};

function redirectRoutes(redirects: Record<string, ReactNode>) {
  return Object.entries(redirects).map(([from, element]) => (
    <Route key={from} path={from} element={element} />
  ));
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

function MainLayout() {
  const { open: sidebarOpen, setOpen: setSidebarOpen } = useSidebarStore();
  useSpaceResolver();

  return (
    <SidebarProvider open={sidebarOpen} onOpenChange={setSidebarOpen}>
      <AppSidebar />
      {/* `bg-canvas` overrides SidebarInset's own `bg-background`: the content
          column is page canvas (grey), not a component surface (white). */}
      {/* The scroll lives HERE, not on an inner div: a scroll container inside
          the inset would narrow the content by the scrollbar width while the
          header above it kept the full width, and the profile would sit 15px
          further right than the content it is supposed to line up with. */}
      <SidebarInset className="bg-canvas h-svh overflow-y-auto">
        <ShellHeader />
        {/* Must stay visible on every route, including the settings layouts and
            the permission-denied pages a persona is precisely there to provoke. */}
        <ViewAsBanner />
        {/* Full-bleed surfaces (anything that owns its own height) opt out
            with `data-full-bleed` on their root. */}
        <div className="max-w-page px-gutter mx-auto w-full pt-8 pb-18 has-[[data-full-bleed]]:max-w-none has-[[data-full-bleed]]:p-0">
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

/**
 * The chat brings its OWN shell (`modules/chat/chat-shell.tsx`) — Studio's
 * navigation is not its navigation — so its routes sit beside MainLayout's
 * rather than inside them. They keep the realtime sync: a chat turn runs
 * agents, and their progress is pushed on the same stream.
 *
 * The space is resolved HERE, above the route gate: `RouteGate` waits on a
 * resolved space before it refuses, and the shell that also resolves it only
 * mounts once the gate lets it through.
 */
function ChatLayout() {
  useSpaceResolver();
  return (
    <GlobalRealtimeSync>
      <Outlet />
    </GlobalRealtimeSync>
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
  const { features } = useAppConfig();
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

export function App() {
  const { user, loading } = useAuth();
  const { features } = useAppConfig();
  const location = useLocation();
  // A routed modal carries the screen it opened over. While one is up the main
  // route tree renders from THAT location, so the page underneath stays exactly
  // as the user left it — scroll, filters and all — instead of unmounting.
  const explicitBackground = useBackgroundLocation();
  // Opened cold — a pasted link, a reload, a new tab — there is no screen to
  // float over, so the dashboard stands in. The surface is then a modal in
  // every case, which removes the second, page-shaped rendering of it that
  // otherwise had to exist and had to be kept looking like the first.
  const isOverlayPath = OVERLAY_PREFIXES.some((p) => location.pathname.startsWith(p));
  const modalBackground =
    explicitBackground ??
    (isOverlayPath ? { ...location, pathname: "/", search: "", hash: "", state: null } : null);
  useExternalRedirect(!!user);

  if (loading) {
    return <BootScreen />;
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
        <Routes location={modalBackground ?? location}>
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
          {/* Beside MainLayout, not inside it: see `ChatLayout`. */}
          <Route element={<ChatLayout />}>{flatPaths("chat").map(pageRoute)}</Route>
          <Route
            element={
              <GlobalRealtimeSync>
                <MainLayout />
              </GlobalRealtimeSync>
            }
          >
            {flatPaths("main").map(pageRoute)}
            {redirectRoutes(PAGE_REDIRECTS)}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
        {/* Overlay tree — the ONLY home of the routed modals. The tree above
            renders the background location, so a second copy there could never
            match; that is why there is no page-shaped variant to keep in sync. */}
        {modalBackground && (
          <Routes>
            {redirectRoutes(OVERLAY_REDIRECTS)}
            {flatPaths("overlay").map(pageRoute)}
            {layoutRoute("/preferences")}
            <Route
              element={
                <LazyRoute>
                  <UnifiedSettingsLayout />
                </LazyRoute>
              }
            >
              {layoutRoute("/org-settings")}
              {layoutRoute("/workspace-settings")}
            </Route>
          </Routes>
        )}
      </OrgGate>
    </ErrorBoundary>
  );
}
