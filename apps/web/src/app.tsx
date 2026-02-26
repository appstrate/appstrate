import { useState, useRef, useCallback } from "react";
import { Routes, Route, Outlet, useLocation, Navigate, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { FlowList } from "./pages/flow-list";
import { FlowDetailPage } from "./pages/flow-detail";
import { FlowEditorPage } from "./pages/flow-editor";
import { ExecutionDetailPage } from "./pages/execution-detail";
import { ShareableRunPage } from "./pages/shareable-run";
import { PublicShareRunPage } from "./pages/public-share-run";
import { SchedulesListPage } from "./pages/schedules-list";
import { ExecutionsPage } from "./pages/executions-page";
import { LibraryPage } from "./pages/library";
import { CreateOrgPage } from "./pages/create-org";
import { InviteAcceptPage } from "./pages/invite-accept";
import { WelcomePage } from "./pages/welcome";
import { OrgSettingsPage } from "./pages/org-settings";
import { ConnectorsPage } from "./pages/connectors";
import { PreferencesPage } from "./pages/preferences";
import { LoginPage } from "./pages/login";
import { ErrorBoundary } from "./components/error-boundary";
import { OrgSwitcher } from "./components/org-switcher";
import { NotificationBell } from "./components/notification-bell";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "./hooks/use-auth";
import { useOrg } from "./hooks/use-org";
import { useGlobalExecutionSync } from "./hooks/use-global-execution-sync";
import { useProfileAutoSelect } from "./hooks/use-current-profile";
import { useClickOutside } from "./hooks/use-click-outside";
import { Spinner } from "./components/spinner";

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
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useClickOutside(ref, open, close);

  return (
    <div className="user-menu" ref={ref}>
      <button
        className="user-menu-trigger"
        onClick={() => setOpen(!open)}
        aria-label={t("userMenu.ariaLabel")}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
          <circle cx="12" cy="7" r="4" />
        </svg>
      </button>
      {open && (
        <div className="user-menu-dropdown">
          <div className="user-menu-info">
            <span className="user-menu-name">{displayName}</span>
            {isAdmin && <span className="admin-badge">{t("admin")}</span>}
          </div>
          <Link to="/preferences" className="user-menu-item" onClick={() => setOpen(false)}>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            {t("userMenu.preferences")}
          </Link>
          <a
            href="/assets/appstrate-api-guide.zip"
            download="appstrate-api-guide.zip"
            className="user-menu-item"
            onClick={() => setOpen(false)}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            {t("nav.downloadSkill")}
          </a>
          <button className="user-menu-logout" onClick={onLogout}>
            {t("userMenu.logout")}
          </button>
        </div>
      )}
    </div>
  );
}

function MainLayout() {
  const { t } = useTranslation();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { user, profile, logout } = useAuth();
  const { isOrgAdmin } = useOrg();
  const currentPath = location.pathname;

  const handleLogout = async () => {
    await logout();
    queryClient.clear();
  };

  return (
    <div className="container">
      <header>
        <h1>
          <Link to="/" className="logo-link">
            <span>App</span>strate
          </Link>
        </h1>
        <nav className="main-nav">
          <Link
            className={`nav-tab ${currentPath === "/" || currentPath.startsWith("/flows") ? "active" : ""}`}
            to="/"
          >
            {t("nav.flows")}
          </Link>
          <Link
            className={`nav-tab ${currentPath === "/schedules" ? "active" : ""}`}
            to="/schedules"
          >
            {t("nav.schedules")}
          </Link>
          <Link className={`nav-tab ${currentPath === "/library" ? "active" : ""}`} to="/library">
            {t("nav.library")}
          </Link>
        </nav>
        <NotificationBell />
        <OrgSwitcher />
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

  // Allow create-org and welcome routes through without org context
  if (location.pathname === "/create-org" || location.pathname === "/welcome") {
    return <>{children}</>;
  }

  if (loading) {
    return (
      <div className="container">
        <div className="empty-state">
          <Spinner />
        </div>
      </div>
    );
  }

  // No orgs at all — redirect to create
  if (orgs.length === 0) {
    return <Navigate to="/create-org" replace />;
  }

  // Orgs exist but none selected yet (auto-select happening)
  if (!currentOrg) {
    return (
      <div className="container">
        <div className="empty-state">
          <Spinner />
        </div>
      </div>
    );
  }

  return <>{children}</>;
}

export function App() {
  const { user, loading } = useAuth();
  const location = useLocation();

  // Public share routes — no authentication required
  if (location.pathname.startsWith("/share/")) {
    return (
      <ErrorBoundary>
        <Routes>
          <Route path="/share/:token" element={<PublicShareRunPage />} />
        </Routes>
      </ErrorBoundary>
    );
  }

  // Public invitation routes — no authentication required
  if (location.pathname.startsWith("/invite/")) {
    return (
      <ErrorBoundary>
        <Routes>
          <Route path="/invite/:token" element={<InviteAcceptPage />} />
        </Routes>
      </ErrorBoundary>
    );
  }

  if (loading) {
    return (
      <div className="container">
        <div className="empty-state">
          <Spinner />
        </div>
      </div>
    );
  }

  if (!user) {
    return <LoginPage />;
  }

  return (
    <ErrorBoundary>
      <OrgGate>
        <GlobalRealtimeSync>
          <Routes>
            <Route path="/create-org" element={<CreateOrgPage />} />
            <Route path="/welcome" element={<WelcomePage />} />
            <Route path="/flows/:flowId/run" element={<ShareableRunPage />} />
            <Route element={<MainLayout />}>
              <Route path="/" element={<FlowList />} />
              <Route path="/flows/new" element={<FlowEditorPage />} />
              <Route path="/flows/:flowId/edit" element={<FlowEditorPage />} />
              <Route path="/flows/:flowId" element={<FlowDetailPage />} />
              <Route path="/flows/:flowId/executions/:execId" element={<ExecutionDetailPage />} />
              <Route path="/executions" element={<ExecutionsPage />} />
              <Route path="/schedules" element={<SchedulesListPage />} />
              <Route path="/library" element={<LibraryPage />} />
              <Route path="/preferences" element={<PreferencesPage />} />
              <Route path="/connectors" element={<ConnectorsPage />} />
              <Route path="/org-settings" element={<OrgSettingsPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </GlobalRealtimeSync>
      </OrgGate>
    </ErrorBoundary>
  );
}
