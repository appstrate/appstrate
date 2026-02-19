import { useState, useRef, useEffect } from "react";
import { Routes, Route, Outlet, useLocation, Navigate, Link } from "react-router-dom";
import { FlowList } from "./pages/flow-list";
import { FlowDetailPage } from "./pages/flow-detail";
import { FlowEditorPage } from "./pages/flow-editor";
import { ExecutionDetailPage } from "./pages/execution-detail";
import { ShareableRunPage } from "./pages/shareable-run";
import { PublicShareRunPage } from "./pages/public-share-run";
import { ServicesListPage } from "./pages/services-list";
import { SchedulesListPage } from "./pages/schedules-list";
import { LibraryPage } from "./pages/library";
import { CreateOrgPage } from "./pages/create-org";
import { OrgSettingsPage } from "./pages/org-settings";
import { LoginPage } from "./pages/login";
import { ErrorBoundary } from "./components/error-boundary";
import { OrgSwitcher } from "./components/org-switcher";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "./hooks/use-auth";
import { useOrg } from "./hooks/use-org";
import { useGlobalExecutionSync } from "./hooks/use-global-execution-sync";
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
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div className="user-menu" ref={ref}>
      <button
        className="user-menu-trigger"
        onClick={() => setOpen(!open)}
        aria-label="Menu utilisateur"
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
            {isAdmin && <span className="admin-badge">admin</span>}
          </div>
          <button className="user-menu-logout" onClick={onLogout}>
            Deconnexion
          </button>
        </div>
      )}
    </div>
  );
}

function MainLayout() {
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
            Flows
          </Link>
          <Link
            className={`nav-tab ${currentPath === "/schedules" ? "active" : ""}`}
            to="/schedules"
          >
            Planifications
          </Link>
          <Link className={`nav-tab ${currentPath === "/library" ? "active" : ""}`} to="/library">
            Bibliotheque
          </Link>
          <Link className={`nav-tab ${currentPath === "/services" ? "active" : ""}`} to="/services">
            Services
          </Link>
        </nav>
        <OrgSwitcher />
        <UserMenu
          displayName={profile?.display_name || user!.email || ""}
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
  return <>{children}</>;
}

function OrgGate({ children }: { children: React.ReactNode }) {
  const { currentOrg, orgs, loading } = useOrg();
  const location = useLocation();

  // Allow create-org route through without org context
  if (location.pathname === "/create-org") {
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
            <Route path="/flows/:flowId/run" element={<ShareableRunPage />} />
            <Route element={<MainLayout />}>
              <Route path="/" element={<FlowList />} />
              <Route path="/flows/new" element={<FlowEditorPage />} />
              <Route path="/flows/:flowId/edit" element={<FlowEditorPage />} />
              <Route path="/flows/:flowId" element={<FlowDetailPage />} />
              <Route path="/flows/:flowId/executions/:execId" element={<ExecutionDetailPage />} />
              <Route path="/schedules" element={<SchedulesListPage />} />
              <Route path="/library" element={<LibraryPage />} />
              <Route path="/services" element={<ServicesListPage />} />
              <Route path="/org-settings" element={<OrgSettingsPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </GlobalRealtimeSync>
      </OrgGate>
    </ErrorBoundary>
  );
}
