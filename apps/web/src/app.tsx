import { useState, useRef, useEffect } from "react";
import { Routes, Route, useLocation, Navigate, Link } from "react-router-dom";
import { FlowList } from "./pages/flow-list";
import { FlowDetailPage } from "./pages/flow-detail";
import { ExecutionDetailPage } from "./pages/execution-detail";
import { ServicesListPage } from "./pages/services-list";
import { SchedulesListPage } from "./pages/schedules-list";
import { LoginPage } from "./pages/login";
import { ErrorBoundary } from "./components/error-boundary";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "./hooks/use-auth";
import { Spinner } from "./components/spinner";

function UserMenu({ displayName, isAdmin, onLogout }: { displayName: string; isAdmin?: boolean; onLogout: () => void }) {
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
      <button className="user-menu-trigger" onClick={() => setOpen(!open)} aria-label="Menu utilisateur">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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

export function App() {
  const location = useLocation();
  const queryClient = useQueryClient();
  const { user, profile, loading, logout } = useAuth();

  const handleLogout = async () => {
    await logout();
    queryClient.clear();
  };

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

  const currentPath = location.pathname;

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
          <Link className={`nav-tab ${currentPath === "/services" ? "active" : ""}`} to="/services">
            Services
          </Link>
        </nav>
        <UserMenu
          displayName={profile?.display_name || user.email || ""}
          isAdmin={profile?.role === "admin"}
          onLogout={() => void handleLogout()}
        />
      </header>

      <ErrorBoundary>
        <Routes>
          <Route path="/" element={<FlowList />} />
          <Route path="/flows/:flowId" element={<FlowDetailPage />} />
          <Route path="/flows/:flowId/executions/:execId" element={<ExecutionDetailPage />} />
          <Route path="/schedules" element={<SchedulesListPage />} />
          <Route path="/services" element={<ServicesListPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </ErrorBoundary>
    </div>
  );
}
