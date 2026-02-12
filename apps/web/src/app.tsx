import { Routes, Route, useLocation, Navigate, Link } from "react-router-dom";
import { FlowList } from "./pages/flow-list";
import { FlowDetailPage } from "./pages/flow-detail";
import { ExecutionDetailPage } from "./pages/execution-detail";
import { ServicesListPage } from "./pages/services-list";
import { SchedulesListPage } from "./pages/schedules-list";
import { LoginPage } from "./pages/login";
import { ErrorBoundary } from "./components/error-boundary";
import { useAuth } from "./hooks/use-auth";
import { Spinner } from "./components/spinner";

export function App() {
  const location = useLocation();
  const { user, profile, loading, logout } = useAuth();

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
        <div className="user-menu">
          <span className="user-name">
            {profile?.display_name || user.email}
            {profile?.role === "admin" && <span className="admin-badge">admin</span>}
          </span>
          <button className="logout-btn" onClick={() => void logout()}>
            Deconnexion
          </button>
        </div>
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
