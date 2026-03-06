import { useState, useRef, useCallback } from "react";
import { Routes, Route, Outlet, useLocation, Navigate, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { PackageList } from "./pages/package-list";
import { UnifiedPackageDetailPage } from "./pages/unified-package-detail";
import { PackageEditorPage } from "./pages/package-editor";
import { ExecutionDetailPage } from "./pages/execution-detail";
import { ShareableRunPage } from "./pages/shareable-run";
import { PublicShareRunPage } from "./pages/public-share-run";
import { SchedulesListPage } from "./pages/schedules-list";
import { ExecutionsPage } from "./pages/executions-page";
import { MarketplacePage } from "./pages/marketplace";
import { MarketplaceDetailPage } from "./pages/marketplace-detail";
import { MarketplaceUpdatesPage } from "./pages/marketplace-updates";
import { MarketplacePublishPage } from "./pages/marketplace-publish";
import { MarketplaceConnectionPage } from "./pages/marketplace-connection";
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
import { User, Settings, Download, FileText, LogOut, Store } from "lucide-react";

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
        <User size={18} />
      </button>
      {open && (
        <div className="user-menu-dropdown">
          <div className="user-menu-info">
            <span className="user-menu-name">{displayName}</span>
            {isAdmin && <span className="admin-badge">{t("admin")}</span>}
          </div>
          <Link to="/preferences" className="user-menu-item" onClick={() => setOpen(false)}>
            <Settings size={14} />
            {t("userMenu.preferences")}
          </Link>
          <a
            href="/api/docs"
            target="_blank"
            rel="noopener noreferrer"
            className="user-menu-item"
            onClick={() => setOpen(false)}
          >
            <FileText size={14} />
            {t("userMenu.apiDocs")}
          </a>
          <a
            href="/assets/appstrate-api-guide.zip"
            download="appstrate-api-guide.zip"
            className="user-menu-item"
            onClick={() => setOpen(false)}
          >
            <Download size={14} />
            {t("nav.downloadSkill")}
          </a>
          <button className="user-menu-logout" onClick={onLogout}>
            <LogOut size={14} />
            {t("userMenu.logout")}
          </button>
        </div>
      )}
    </div>
  );
}

function MainLayout() {
  const queryClient = useQueryClient();
  const { user, profile, logout } = useAuth();
  const { isOrgAdmin } = useOrg();

  const handleLogout = async () => {
    await logout();
    queryClient.clear();
  };

  return (
    <div className="container">
      <header>
        <Link to="/" className="logo-link">
          <img src="/logo.svg" alt="Appstrate" className="app-logo" />
        </Link>
        <Link to="/marketplace" className="nav-icon-link" title="Marketplace">
          <Store size={18} />
        </Link>
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
            <Route path="/flows/:scope/:name/run" element={<ShareableRunPage />} />
            <Route element={<MainLayout />}>
              <Route path="/" element={<PackageList />} />
              <Route path="/flows/new" element={<PackageEditorPage type="flow" />} />
              <Route path="/flows/:scope/:name/edit" element={<PackageEditorPage type="flow" />} />
              <Route
                path="/flows/:scope/:name"
                element={<UnifiedPackageDetailPage type="flow" />}
              />
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
              <Route path="/skills/new" element={<PackageEditorPage type="skill" />} />
              <Route
                path="/skills/:scope/:name/edit"
                element={<PackageEditorPage type="skill" />}
              />
              <Route
                path="/skills/:scope/:name"
                element={<UnifiedPackageDetailPage type="skill" />}
              />
              <Route
                path="/skills/:scope/:name/:version"
                element={<UnifiedPackageDetailPage type="skill" />}
              />
              <Route path="/extensions/new" element={<PackageEditorPage type="extension" />} />
              <Route
                path="/extensions/:scope/:name/edit"
                element={<PackageEditorPage type="extension" />}
              />
              <Route
                path="/extensions/:scope/:name"
                element={<UnifiedPackageDetailPage type="extension" />}
              />
              <Route
                path="/extensions/:scope/:name/:version"
                element={<UnifiedPackageDetailPage type="extension" />}
              />
              <Route path="/library" element={<Navigate to="/?tab=skills" replace />} />
              <Route path="/marketplace" element={<MarketplacePage />} />
              <Route path="/marketplace/updates" element={<MarketplaceUpdatesPage />} />
              <Route path="/marketplace/publish" element={<MarketplacePublishPage />} />
              <Route path="/marketplace/connection" element={<MarketplaceConnectionPage />} />
              <Route path="/marketplace/:scope/:name" element={<MarketplaceDetailPage />} />
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
